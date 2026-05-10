import "server-only";
import { logger } from "@/lib/logger";
import { sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { emailSendLog } from "@/db/schema/email-send-log";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { eq } from "drizzle-orm";
import { ValidationError } from "@/lib/errors";
import {
  graphFetchAs,
  graphFetchBinaryAs,
  GraphRequestError,
} from "@/lib/graph-token";

const EMAIL_SEND_LOG_FEATURE = "lead.email_activity";

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

  // Best-effort: snapshot sender email for the email_send_log row. Never
  // block the actual send if this lookup fails.
  let fromUserEmailSnapshot = "";
  try {
    const [u] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, args.userId))
      .limit(1);
    fromUserEmailSnapshot = u?.email ?? "";
  } catch (err) {
    logger.error("graph_email.user_lookup_failed", {
      userId: args.userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  // Insert a 'sending' email_send_log row (best-effort) so admin failure
  // dashboard sees this attempt even if Graph crashes mid-call.
  let logId: string | null = null;
  const sendStart = Date.now();
  try {
    const inserted = await db
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
      })
      .returning({ id: emailSendLog.id });
    logId = inserted[0]?.id ?? null;
  } catch (err) {
    logger.error("graph_email.email_send_log_insert_failed", {
      userId: args.userId,
      leadId: args.leadId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
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

// Re-export for convenience
export { graphFetchBinaryAs };
