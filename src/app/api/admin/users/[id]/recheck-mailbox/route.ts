import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import { checkMailboxKind } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Phase 15 — admin-only "Re-check mailbox" endpoint. Forces a fresh
 * Microsoft Graph probe for an arbitrary user (bypasses the 24h cache)
 * and persists the resolution. Mirrors `/api/me/can-send-email?refresh=1`
 * but for someone other than the caller.
 *
 * Returns the same `PreflightResult` shape so the admin client can render
 * `kind` + `mailboxCheckedAt` without a follow-up GET.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const admin = await requireAdmin();
  const { id } = await ctx.params;

  const [u] = await db
    .select({
      userId: users.id,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!u) {
    return NextResponse.json(
      { ok: false, kind: "unknown", message: "User not found", cached: false },
      { status: 404 },
    );
  }

  try {
    const result = await checkMailboxKind(u, { force: true });

    // Re-read to surface the freshly-persisted timestamp; checkMailboxKind
    // updates `mailbox_checked_at` server-side but the returned shape
    // doesn't carry it, and the UI wants to render "checked just now".
    const [refreshed] = await db
      .select({
        mailboxKind: users.mailboxKind,
        mailboxCheckedAt: users.mailboxCheckedAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    await writeAudit({
      actorId: admin.id,
      actorEmailSnapshot: admin.email,
      action: "email.recheck_mailbox",
      targetType: "user",
      targetId: id,
      after: {
        kind: result.kind,
        previousKind: u.mailboxKind,
        mailboxCheckedAt: refreshed?.mailboxCheckedAt ?? null,
      },
    });

    return NextResponse.json({
      ...result,
      mailboxKind: refreshed?.mailboxKind ?? result.kind,
      mailboxCheckedAt: refreshed?.mailboxCheckedAt ?? null,
    });
  } catch (err) {
    logger.error("admin.recheck_mailbox_failed", {
      userId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        ok: false,
        kind: "unknown",
        message: "Mailbox re-check failed. See server logs.",
        cached: false,
      },
      { status: 500 },
    );
  }
}
