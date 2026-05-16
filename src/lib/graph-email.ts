import "server-only";
// consistency-exempt: canonical-email-path: delegated /me/sendMail preserves real per-user mailbox identity (From: the user, no "sent on behalf of" footer, faithful Sent-Items + attachment capture) that app-permission sendEmailAs structurally cannot; E2E + preflight + consent + dedupe gates are replicated inline. 2026-05-16
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import { sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { emailSendLog } from "@/db/schema/email-send-log";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { eq } from "drizzle-orm";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { isGraphAppConfigured } from "@/lib/email/graph-app-token";
import { checkMailboxKind } from "@/lib/email/preflight";
import {
  graphFetchAs,
  GraphRequestError,
} from "@/lib/graph-token";

const EMAIL_SEND_LOG_FEATURE = "lead.email_activity";

// Short window for accidental-duplicate suppression. A double-click /
// two-tab / retried-server-action lands in the same bucket and is rejected;
// a deliberate identical resend later falls in a new bucket and proceeds.
// Email is NOT idempotent (graph-app-token.ts documents sendMail is
// non-retry-safe), so a time-bucketed key — not the jobs-queue unbounded
// key — is the correct adaptation.
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

interface SentMessage {
  id: string;
  internetMessageId: string;
  subject: string;
  body: { contentType: string; content: string };
  bodyPreview: string;
  sentDateTime: string;
  from: { emailAddress: { address: string; name?: string } };
  toRecipients: Array<{ emailAddress: { address: string; name?: string } }>;
  hasAttachments: boolean;
}

interface GraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

/**
 * Sends an email via Graph as the signed-in user, then walks Sent Items
 * back to the freshly-sent message and persists it as an `activity` row
 * with `kind=email`, `direction=outbound`. Returns the activity id.
 *
 * Attachments are sent inline as base64 (Graph's `fileAttachment` type),
 * capped at 3MB each. Larger attachments need `createUploadSession` —
 * out of scope for v1.
 */
export async function sendEmailAndTrack(args: {
  leadId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; contentType: string; bytes: Uint8Array }>;
}): Promise<{ activityId: string }> {
  const cleanAttachments = (args.attachments ?? []).map((a, i) => {
    if (a.bytes.byteLength > 3 * 1024 * 1024) {
      throw new ValidationError(
        `Attachment ${a.filename} exceeds the 3MB v1 limit. Strip it or upload to a shared link.`,
        { filename: a.filename, sizeBytes: a.bytes.byteLength, limit: 3 * 1024 * 1024 },
      );
    }
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.contentType || "application/octet-stream",
      contentBytes: Buffer.from(a.bytes).toString("base64"),
      // microsoft.graph requires this header but accepts it on the inner object
      _idx: i,
    } as Record<string, unknown>;
  });

  const sendBody = {
    message: {
      subject: args.subject,
      body: { contentType: "Text", content: args.body },
      toRecipients: [{ emailAddress: { address: args.to } }],
      attachments: cleanAttachments.map((a) => {
        const copy = { ...a };
        delete copy._idx;
        return copy;
      }),
    },
    saveToSentItems: true,
  };

  const totalAttachmentBytes = (args.attachments ?? []).reduce(
    (n, a) => n + a.bytes.byteLength,
    0,
  );
  const attachmentCount = args.attachments?.length ?? 0;

  // One select for everything the gates + log row need from the sender:
  // email (log snapshot) + entraOid/mailboxKind/mailboxCheckedAt (preflight).
  const [senderRow] = await db
    .select({
      email: users.email,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, args.userId))
    .limit(1);
  if (!senderRow) {
    throw new ValidationError("Sender account not found.");
  }
  const fromUserEmailSnapshot = senderRow.email ?? "";

  // Mailbox preflight. checkMailboxKind probes via app-permission Graph
  // (graphAppRequest) — if app credentials are NOT configured it returns
  // ok:false and would wrongly block a delegated send that needs only the
  // user's own token. So gate the preflight on isGraphAppConfigured(); when
  // app creds are absent, skip it (delegated /me/sendMail surfaces an
  // on-prem mailbox as a Graph error the caller already handles).
  if (isGraphAppConfigured()) {
    const preflight = await checkMailboxKind({
      userId: args.userId,
      entraOid: senderRow.entraOid,
      mailboxKind: senderRow.mailboxKind,
      mailboxCheckedAt: senderRow.mailboxCheckedAt,
    });
    if (!preflight.ok) {
      await db.insert(emailSendLog).values({
        fromUserId: args.userId,
        fromUserEmailSnapshot,
        toEmail: args.to,
        feature: EMAIL_SEND_LOG_FEATURE,
        featureRecordId: args.leadId,
        subject: args.subject,
        status: "blocked_preflight",
        errorCode: "MAILBOX_NOT_EXCHANGE_ONLINE",
        errorMessage:
          preflight.message ?? `Sender mailbox kind: ${preflight.kind}`,
      });
      logger.warn("graph_email.preflight_blocked", {
        userId: args.userId,
        leadId: args.leadId,
        mailboxKind: preflight.kind,
      });
      // checkMailboxKind already writes email.preflight.failed when it makes
      // a fresh determination; the blocked_preflight log row is the
      // per-attempt forensic record (parity with sendEmailAs). No second
      // audit row here (would double-count).
      throw new ForbiddenError(
        preflight.message ?? "Your mailbox can't send email. Contact MWG IT.",
      );
    }
  } else {
    logger.warn("graph_email.preflight_skipped_app_unconfigured", {
      userId: args.userId,
      leadId: args.leadId,
    });
  }

  // Short-window send idempotency. Mirror the jobs-queue pattern (nullable
  // dedupe column + partial unique index): a deterministic key over
  // (feature, user, lead, recipient, subject, 2-min bucket). onConflictDoNothing
  // + a 0-row return ⇒ a duplicate submit is already in flight / just
  // completed — reject instead of issuing a second real Graph send.
  const windowBucket = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  const dedupeKey = createHash("sha256")
    .update(
      `${EMAIL_SEND_LOG_FEATURE}|${args.userId}|${args.leadId}|${args.to.toLowerCase()}|${args.subject}|${windowBucket}`,
    )
    .digest("hex");

  const sendStart = Date.now();
  // A genuine DB error here propagates (fails the send loudly) rather than
  // being swallowed — a dedupe gate that can be silently skipped on insert
  // error is not a gate. Deliberate behavior change vs the prior best-effort
  // insert: correct for an idempotency control.
  const dedupeInsert = await db
    .insert(emailSendLog)
    .values({
      fromUserId: args.userId,
      fromUserEmailSnapshot,
      toEmail: args.to,
      feature: EMAIL_SEND_LOG_FEATURE,
      featureRecordId: args.leadId,
      subject: args.subject,
      hasAttachments: attachmentCount > 0,
      attachmentCount,
      totalSizeBytes: totalAttachmentBytes || null,
      status: "sending",
      dedupeKey,
    })
    .onConflictDoNothing({ target: emailSendLog.dedupeKey })
    .returning({ id: emailSendLog.id });
  const logId: string | null = dedupeInsert[0]?.id ?? null;
  if (!logId) {
    logger.warn("graph_email.duplicate_send_suppressed", {
      userId: args.userId,
      leadId: args.leadId,
      to: args.to,
    });
    throw new ConflictError(
      "This email was just sent (or is sending). Refresh the lead to see it.",
    );
  }

  try {
    await graphFetchAs<unknown>(args.userId, "/me/sendMail", {
      method: "POST",
      body: JSON.stringify(sendBody),
    });
  } catch (err) {
    // Log the failure to email_send_log (best-effort) before rethrowing.
    if (logId) {
      try {
        const isGraphErr = err instanceof GraphRequestError;
        await db
          .update(emailSendLog)
          .set({
            status: "failed",
            errorCode: isGraphErr
              ? `GRAPH_${err.status}`
              : "GRAPH_ERROR",
            errorMessage:
              err instanceof Error ? err.message : String(err),
            httpStatus: isGraphErr ? err.status : null,
            durationMs: Date.now() - sendStart,
          })
          .where(inArray(emailSendLog.id, [logId]));
      } catch (logErr) {
        logger.error("graph_email.email_send_log_failure_update_failed", {
          logId,
          errorMessage:
            logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    }
    throw err;
  }

  // Mark the send as accepted by Graph (HTTP 202; per-recipient
  // deliverability not guaranteed).
  if (logId) {
    try {
      await db
        .update(emailSendLog)
        .set({
          status: "sent",
          sentAt: new Date(),
          durationMs: Date.now() - sendStart,
        })
        .where(inArray(emailSendLog.id, [logId]));
    } catch (err) {
      logger.error("graph_email.email_send_log_success_update_failed", {
        logId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Graph's /me/sendMail returns 202 Accepted with no body. We need to walk
  // Sent Items by subject + recipient, polling briefly until it shows up.
  const sent = await pollSentMessage(args.userId, {
    to: args.to,
    subject: args.subject,
  });

  // Backfill the Graph message id on the email_send_log row (best-effort).
  if (logId && sent?.id) {
    try {
      await db
        .update(emailSendLog)
        .set({ graphMessageId: sent.id })
        .where(inArray(emailSendLog.id, [logId]));
    } catch (err) {
      logger.error("graph_email.email_send_log_message_id_update_failed", {
        logId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const inserted = await db
    .insert(activities)
    .values({
      leadId: args.leadId,
      userId: args.userId,
      kind: "email",
      direction: "outbound",
      subject: sent?.subject ?? args.subject,
      body: sent?.body?.content ?? args.body,
      occurredAt: sent?.sentDateTime
        ? new Date(sent.sentDateTime)
        : sql`now()`,
      graphMessageId: sent?.id ?? null,
      graphInternetMessageId: sent?.internetMessageId ?? null,
    })
    .returning({ id: activities.id });

  // Backfill attachment metadata + binaries to Blob if Graph reported any.
  if (sent?.hasAttachments && sent.id) {
    await persistGraphAttachments({
      userId: args.userId,
      activityId: inserted[0].id,
      graphMessageId: sent.id,
    });
  }

  await db
    .update(leads)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(leads.id, args.leadId));

  return { activityId: inserted[0].id };
}

async function pollSentMessage(
  userId: string,
  match: { to: string; subject: string },
  attempts = 5,
  delayMs = 700,
): Promise<SentMessage | null> {
  const subjectFilter = match.subject.replace(/'/g, "''");
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await graphFetchAs<{ value: SentMessage[] }>(
        userId,
        `/me/mailFolders/sentitems/messages?$top=10&$orderby=sentDateTime desc&$filter=${encodeURIComponent(`subject eq '${subjectFilter}'`)}&$select=id,internetMessageId,subject,body,bodyPreview,sentDateTime,from,toRecipients,hasAttachments`,
      );
      const hit = data.value.find((m) =>
        m.toRecipients.some(
          (r) =>
            r.emailAddress.address.toLowerCase() === match.to.toLowerCase(),
        ),
      );
      if (hit) return hit;
    } catch (err) {
      if (err instanceof GraphRequestError && err.status === 404) {
        // Sent Items not found — non-fatal.
        return null;
      }
      // Transient — retry.
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function persistGraphAttachments(args: {
  userId: string;
  activityId: string;
  graphMessageId: string;
}): Promise<void> {
  const { put } = await import("@vercel/blob");
  try {
    const list = await graphFetchAs<{ value: GraphAttachmentMeta[] }>(
      args.userId,
      `/me/messages/${args.graphMessageId}/attachments?$select=id,name,contentType,size,isInline`,
    );
    for (const meta of list.value) {
      if (meta.isInline) continue;
      const detail = await graphFetchAs<{ contentBytes?: string }>(
        args.userId,
        `/me/messages/${args.graphMessageId}/attachments/${meta.id}`,
      );
      if (!detail.contentBytes) continue;
      const buf = Buffer.from(detail.contentBytes, "base64");
      const pathname = `activities/${args.activityId}/${sanitize(meta.name)}`;
      const blob = await put(pathname, buf, {
        access: "private",
        addRandomSuffix: false,
        contentType: meta.contentType || "application/octet-stream",
      });
      await db.insert(attachments).values({
        activityId: args.activityId,
        filename: meta.name,
        contentType: meta.contentType || null,
        sizeBytes: meta.size ?? null,
        blobUrl: blob.url,
        blobPathname: pathname,
      });
    }
  } catch (err) {
    logger.warn("graph_email.attachment_persist_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200);
}

