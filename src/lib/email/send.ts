import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { emailSendLog } from "@/db/schema/email-send-log";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { graphAppRequest, isGraphAppConfigured } from "./graph-app-token";
import { checkMailboxKind } from "./preflight";
import type {
  EmailAttachment,
  EmailRecipient,
  RecipientOutcome,
  SendOptions,
  SendResult,
} from "./types";

const E2E_PATTERN = /\[E2E-[^\]]+\]/;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // Graph fileAttachment ceiling

type FromUser = {
  id: string;
  email: string;
  displayName: string;
  entraOid: string | null;
  mailboxKind: string | null;
  mailboxCheckedAt: Date | null;
};

/**
 * sendEmailAs — Phase 15 generic email entry point. Sends `as` the supplied
 * `fromUserId` via Microsoft Graph application permissions
 * (POST /users/{oid}/sendMail).
 *
 * Every recipient gets a row in `email_send_log`. Every attempt — success
 * or failure — gets a corresponding `audit_log` row.
 *
 * Pre-flight (checkMailboxKind) is enforced server-side: if the sender's
 * mailbox is not exchange_online, recipients are logged as `blocked_preflight`
 * and Graph is never called.
 *
 * The `[E2E-…]` sentinel in subject or any recipient address routes through
 * the test gate: rows logged as `blocked_e2e`, no Graph call. Phase 12
 * convention.
 */
export async function sendEmailAs(opts: SendOptions): Promise<SendResult> {
  const start = Date.now();

  const allRecipients = collectRecipients(opts);
  if (allRecipients.length === 0) {
    throw new ValidationError("sendEmailAs: at least one recipient is required");
  }

  if (!isGraphAppConfigured()) {
    return logBlocked({
      opts,
      fromUser: await safeLoadUser(opts.fromUserId),
      reason: "ENTRA_NOT_CONFIGURED",
      message: "Microsoft Graph application credentials are not configured",
      status: "failed",
      start,
    });
  }

  const [fromUser] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, opts.fromUserId))
    .limit(1);

  if (!fromUser) {
    throw new NotFoundError("user");
  }

  if (!fromUser.entraOid) {
    return logBlocked({
      opts,
      fromUser,
      reason: "NO_ENTRA_OID",
      message: "Sender has no Entra object id; cannot send via app permissions",
      status: "failed",
      start,
    });
  }

  // E2E gate
  const isE2E =
    E2E_PATTERN.test(opts.subject) ||
    allRecipients.some((r) => E2E_PATTERN.test(r.email));
  if (isE2E) {
    return logBlocked({
      opts,
      fromUser,
      reason: "E2E_SENTINEL",
      message: "E2E sentinel present in subject or recipients; skipped delivery",
      status: "blocked_e2e",
      start,
    });
  }

  // Pre-flight on the sender's mailbox
  const preflight = await checkMailboxKind({
    userId: fromUser.id,
    entraOid: fromUser.entraOid,
    mailboxKind: fromUser.mailboxKind,
    mailboxCheckedAt: fromUser.mailboxCheckedAt,
  });
  if (!preflight.ok) {
    return logBlocked({
      opts,
      fromUser,
      reason: "MAILBOX_NOT_EXCHANGE_ONLINE",
      message: preflight.message ?? `Sender mailbox kind: ${preflight.kind}`,
      status: "blocked_preflight",
      start,
      extra: { mailboxKind: preflight.kind },
    });
  }

  // Insert per-recipient `sending` rows so a crash mid-call leaves a trace.
  const totalAttachmentBytes = (opts.attachments ?? []).reduce(
    (n, a) => n + a.bytes.byteLength,
    0,
  );
  const attachmentCount = opts.attachments?.length ?? 0;
  for (const a of opts.attachments ?? []) {
    if (a.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ValidationError(
        `Attachment ${a.filename} exceeds the 3MB Microsoft Graph fileAttachment limit. Use createUploadSession for larger files.`,
      );
    }
  }

  const queuedRows = await db
    .insert(emailSendLog)
    .values(
      allRecipients.map((r) => ({
        fromUserId: fromUser.id,
        fromUserEmailSnapshot: fromUser.email,
        toEmail: r.email,
        toUserId: r.userId ?? null,
        feature: opts.feature,
        featureRecordId: opts.featureRecordId ?? null,
        subject: opts.subject,
        hasAttachments: attachmentCount > 0,
        attachmentCount,
        totalSizeBytes: totalAttachmentBytes || null,
        status: "sending" as const,
        metadata: opts.metadata ?? null,
      })),
    )
    .returning({ id: emailSendLog.id, toEmail: emailSendLog.toEmail });

  // Compose the Graph payload
  const html = appendFooter(opts.html, fromUser.displayName);
  const message = {
    message: {
      subject: opts.subject,
      body: { contentType: "HTML", content: html },
      toRecipients: opts.to.map(toGraphRecipient),
      ccRecipients: (opts.cc ?? []).map(toGraphRecipient),
      bccRecipients: (opts.bcc ?? []).map(toGraphRecipient),
      attachments: (opts.attachments ?? []).map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.filename,
        contentType: a.contentType || "application/octet-stream",
        contentBytes: Buffer.from(a.bytes).toString("base64"),
      })),
    },
    saveToSentItems: true,
  };

  const result = await graphAppRequest(
    "POST",
    `/users/${fromUser.entraOid}/sendMail`,
    message,
  );
  const durationMs = Date.now() - start;

  const finalStatus = result.ok ? "sent" : "failed";
  const sentAt = result.ok ? new Date() : null;
  await db
    .update(emailSendLog)
    .set({
      status: finalStatus,
      graphMessageId: result.ok ? result.requestId ?? null : null,
      errorCode: result.error?.code ?? null,
      errorMessage: result.error?.message ?? null,
      httpStatus: result.status,
      durationMs,
      sentAt,
      requestId: result.requestId ?? null,
    })
    .where(
      inArray(
        emailSendLog.id,
        queuedRows.map((r) => r.id),
      ),
    );

  await writeAudit({
    actorId: fromUser.id,
    actorEmailSnapshot: fromUser.email,
    action: result.ok ? "email.send.success" : "email.send.failed",
    targetType: "email",
    targetId: queuedRows[0]?.id,
    after: {
      feature: opts.feature,
      featureRecordId: opts.featureRecordId ?? null,
      recipientCount: allRecipients.length,
      subject: opts.subject,
      errorCode: result.error?.code ?? null,
      durationMs,
      requestId: result.requestId ?? null,
    },
  });

  if (!result.ok) {
    logger.warn("email_send.failed", {
      fromUserId: fromUser.id,
      feature: opts.feature,
      errorCode: result.error?.code,
      httpStatus: result.status,
      requestId: result.requestId,
    });
  }

  return {
    ok: result.ok,
    durationMs,
    graphRequestId: result.requestId,
    perRecipient: queuedRows.map<RecipientOutcome>((r) => ({
      email: r.toEmail,
      logId: r.id,
      status: result.ok ? "sent" : "failed",
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
    })),
  };
}

function collectRecipients(opts: SendOptions): EmailRecipient[] {
  return [...opts.to, ...(opts.cc ?? []), ...(opts.bcc ?? [])];
}

function toGraphRecipient(r: EmailRecipient) {
  return { emailAddress: { address: r.email } };
}

function appendFooter(html: string, displayName: string): string {
  const safeName = displayName.replace(/[<>]/g, "");
  const footer = `<p style="color:#888;font-size:12px;margin-top:32px;border-top:1px solid #ddd;padding-top:8px">Sent on behalf of ${safeName} via MWG CRM.</p>`;
  return `${html}${footer}`;
}

async function safeLoadUser(userId: string): Promise<FromUser | null> {
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ?? null;
}

type BlockedArgs = {
  opts: SendOptions;
  fromUser: FromUser | null;
  reason: string;
  message: string;
  status: "failed" | "blocked_preflight" | "blocked_e2e";
  start: number;
  extra?: Record<string, unknown>;
};

async function logBlocked(args: BlockedArgs): Promise<SendResult> {
  if (!args.fromUser) {
    throw new NotFoundError("user");
  }
  const allRecipients = collectRecipients(args.opts);
  const totalAttachmentBytes = (args.opts.attachments ?? []).reduce(
    (n, a) => n + a.bytes.byteLength,
    0,
  );
  const attachmentCount = args.opts.attachments?.length ?? 0;

  const rows = await db
    .insert(emailSendLog)
    .values(
      allRecipients.map((r) => ({
        fromUserId: args.fromUser!.id,
        fromUserEmailSnapshot: args.fromUser!.email,
        toEmail: r.email,
        toUserId: r.userId ?? null,
        feature: args.opts.feature,
        featureRecordId: args.opts.featureRecordId ?? null,
        subject: args.opts.subject,
        hasAttachments: attachmentCount > 0,
        attachmentCount,
        totalSizeBytes: totalAttachmentBytes || null,
        status: args.status,
        errorCode: args.reason,
        errorMessage: args.message,
        durationMs: Date.now() - args.start,
        sentAt: null,
        metadata: { ...(args.opts.metadata ?? {}), ...(args.extra ?? {}) },
      })),
    )
    .returning({ id: emailSendLog.id, toEmail: emailSendLog.toEmail });

  const auditAction =
    args.status === "blocked_e2e"
      ? "email.send.blocked_e2e"
      : args.status === "blocked_preflight"
        ? "email.send.failed"
        : "email.send.failed";

  await writeAudit({
    actorId: args.fromUser.id,
    actorEmailSnapshot: args.fromUser.email,
    action: auditAction,
    targetType: "email",
    targetId: rows[0]?.id,
    after: {
      feature: args.opts.feature,
      featureRecordId: args.opts.featureRecordId ?? null,
      recipientCount: allRecipients.length,
      subject: args.opts.subject,
      errorCode: args.reason,
      reason: args.reason,
      ...(args.extra ?? {}),
    },
  });

  return {
    ok: args.status === "blocked_e2e",
    durationMs: Date.now() - args.start,
    perRecipient: rows.map<RecipientOutcome>((r) => ({
      email: r.toEmail,
      logId: r.id,
      status: args.status,
      errorCode: args.reason,
      errorMessage: args.message,
    })),
  };
}

// Re-exports for downstream consumers that don't want to import from /types
export type { SendOptions, SendResult, EmailAttachment, EmailRecipient } from "./types";
