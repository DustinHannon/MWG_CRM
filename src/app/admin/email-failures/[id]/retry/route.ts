import "server-only";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { emailSendLog } from "@/db/schema/email-send-log";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import { sendEmailAs } from "@/lib/email";
import { escapeHtml } from "@/lib/security/escape-html";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 15 — admin "retry this failed email" endpoint.
 *
 * Constraints:
 *   - Admin-only.
 *   - Only `status='failed'` rows are retryable. `blocked_preflight` is a
 *     mailbox config issue (sender's mailbox is not Exchange Online),
 *     so retrying without fixing the config will fail the same way; we
 *     return 422 to make that explicit.
 *   - The original HTML body is intentionally NOT stored in
 *     `email_send_log` (bodies can be large). The retry therefore sends
 *     a placeholder body that is honest about what's happening — admins
 *     use Retry as a "did the failure mode go away?" probe, not as
 *     message recovery.
 *   - The new send is logged with feature `<original>.retry` so future
 *     queries can distinguish probe sends from organic ones.
 *   - After `sendEmailAs` returns, we patch the new log row's
 *     `retryOfId` to the original — `sendEmailAs` doesn't take that
 *     field directly.
 *   - `audit_log.email.retry` is appended either way (success or
 *     failure) so retry attempts are themselves traceable.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const admin = await requireAdmin();
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json(
      { error: "invalid_id", message: "Email log id must be a UUID." },
      { status: 400 },
    );
  }

  const [original] = await db
    .select()
    .from(emailSendLog)
    .where(eq(emailSendLog.id, id))
    .limit(1);

  if (!original) {
    return NextResponse.json(
      { error: "not_found", message: "Email log row not found." },
      { status: 404 },
    );
  }

  if (original.status === "blocked_preflight") {
    return NextResponse.json(
      {
        error: "not_retryable",
        message:
          "Cannot retry preflight-blocked sends — the sender's mailbox is not Exchange Online. Fix the mailbox configuration first.",
      },
      { status: 422 },
    );
  }

  if (original.status !== "failed") {
    return NextResponse.json(
      {
        error: "not_retryable",
        message: `Only 'failed' rows can be retried (this row is '${original.status}').`,
      },
      { status: 422 },
    );
  }

  // Honest placeholder body: explicit about what we're sending and why.
  // Admins use this to probe whether the failure mode has cleared, not
  // to recover the original message content.
  const placeholderHtml = `
    <p><em>Retry of failed send. Original body content was not stored.
    If this email is required, recompose and send manually.</em></p>
    <p><strong>Original subject:</strong> ${escapeHtml(original.subject)}</p>
    <p><strong>Original error:</strong> ${escapeHtml(
      original.errorCode ?? "(none)",
    )}: ${escapeHtml(original.errorMessage ?? "")}</p>
  `.trim();

  const retryFeature = `${original.feature}.retry`;
  const baseMetadata =
    (original.metadata as Record<string, unknown> | null) ?? {};
  const retryMetadata: Record<string, unknown> = {
    ...baseMetadata,
    retryOfId: original.id,
    retryRequestedById: admin.id,
    retryRequestedAt: new Date().toISOString(),
  };

  let result;
  try {
    result = await sendEmailAs({
      fromUserId: original.fromUserId,
      to: [
        {
          email: original.toEmail,
          userId: original.toUserId ?? undefined,
        },
      ],
      subject: original.subject,
      html: placeholderHtml,
      feature: retryFeature,
      featureRecordId: original.featureRecordId ?? undefined,
      metadata: retryMetadata,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeAudit({
      actorId: admin.id,
      action: "email.retry",
      targetType: "email",
      targetId: original.id,
      after: {
        ok: false,
        threw: true,
        errorMessage: message,
        originalErrorCode: original.errorCode,
      },
    });
    return NextResponse.json(
      { error: "send_threw", message },
      { status: 500 },
    );
  }

  // sendEmailAs returns one outcome per recipient — we always pass exactly
  // one recipient on retry, so we take the first.
  const outcome = result.perRecipient[0];
  const newLogId = outcome?.logId ?? null;

  // Patch the new row's retryOfId column. sendEmailAs doesn't accept this
  // field directly; we set it after-the-fact so the log preserves the
  // failure-chain for analytics.
  if (newLogId) {
    try {
      await db
        .update(emailSendLog)
        .set({ retryOfId: original.id })
        .where(eq(emailSendLog.id, newLogId));
    } catch {
      // Non-fatal — the audit log below still records the linkage.
    }
  }

  await writeAudit({
    actorId: admin.id,
    action: "email.retry",
    targetType: "email",
    targetId: original.id,
    after: {
      newLogId,
      newStatus: outcome?.status ?? null,
      originalErrorCode: original.errorCode,
      originalFeature: original.feature,
      retryFeature,
    },
  });

  return NextResponse.json({
    ok: result.ok,
    originalId: original.id,
    newLogId,
    status: outcome?.status ?? null,
  });
}

