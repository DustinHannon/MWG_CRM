import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { MarketingNotConfiguredError } from "@/lib/marketing/errors";
import { sendTestEmail } from "@/lib/marketing/sendgrid/send";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — Admin / canManageMarketing test-send.
 *
 * Sends a single inline-HTML email through SendGrid for diagnostic
 * purposes. The recipient defaults to the requester's own email so a
 * marketing operator can preview a template without risking real send.
 * Admins can override the recipient (helpful for shared mailboxes /
 * QA aliases).
 *
 * Hardening:
 *   - Per-user sliding-window rate limit
 *     (`RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR`).
 *   - Body size cap on `html` to keep abusive payloads off the
 *     SendGrid call.
 *   - SENDGRID_SANDBOX=true in dev makes every call a no-op.
 */

const REQUEST_BODY_SCHEMA = z.object({
  recipientEmail: z.string().email().max(254),
  subject: z.string().min(1).max(255),
  html: z.string().min(1).max(200_000),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();
  // canManageMarketing OR admin. Admin already implies all permissions
  // via getPermissions but we surface both for clarity.
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  // Rate limit: per-user, sliding 1h window.
  const rl = await rateLimit(
    { kind: "test_send", principal: user.id },
    env.RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR,
    60 * 60,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfter ?? 60),
        },
      },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  const parsed = REQUEST_BODY_SCHEMA.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  // Non-admins can only send tests to themselves. Admins can override
  // for shared / QA aliases.
  if (!user.isAdmin) {
    const ownEmail = user.email.toLowerCase();
    const requested = parsed.data.recipientEmail.toLowerCase();
    if (ownEmail !== requested) {
      return NextResponse.json(
        {
          ok: false,
          error: "forbidden",
          detail: "Non-admins can only send test email to themselves.",
        },
        { status: 403 },
      );
    }
  }

  try {
    const result = await sendTestEmail({
      recipientEmail: parsed.data.recipientEmail,
      recipientName: user.displayName,
      subject: parsed.data.subject,
      html: parsed.data.html,
      fromName: env.SENDGRID_FROM_NAME_DEFAULT,
      actorUserId: user.id,
    });

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.TEMPLATE_TEST_SEND,
      targetType: "marketing_template",
      after: {
        recipientEmail: parsed.data.recipientEmail,
        subject: parsed.data.subject,
        bytes: parsed.data.html.length,
        sandbox: env.SENDGRID_SANDBOX,
        messageId: result.messageId,
      },
    });

    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    if (err instanceof MarketingNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: "marketing_not_configured" },
        { status: 503 },
      );
    }
    logger.error("sendgrid.test_send.failed", {
      userId: user.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}
