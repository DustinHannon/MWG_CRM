import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailSendLog } from "@/db/schema/email-send-log";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingLists } from "@/db/schema/marketing-lists";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import {
  SYSTEM_SENTINEL_USER_EMAIL,
  SYSTEM_SENTINEL_USER_ID,
} from "@/lib/constants/system-users";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { resolveListRecipients } from "@/lib/marketing/lists/resolution";
import { withRetry } from "@/lib/marketing/with-retry";
import { getSendGrid } from "./client";

const FEATURE_TEST_SEND = "marketing.test_send";
const FEATURE_CAMPAIGN_SEND = "marketing.campaign_send";

/**
 * Best-effort write of a marketing send failure into `email_send_log`. The
 * admin email-failures dashboard reads this table; without these rows,
 * SendGrid send rejections would be invisible to admins. Never blocks the
 * caller's primary code path.
 */
async function logMarketingSendFailure(args: {
  feature: string;
  featureRecordId: string | null;
  fromUserId: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string;
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
  durationMs: number;
}): Promise<void> {
  try {
    let fromUserId = args.fromUserId;
    let fromUserEmailSnapshot = args.fromEmail;
    // email_send_log.fromUserId is NOT NULL with FK to users(id). If we
    // don't have a real user id (e.g. webhook-only test send through an
    // API key), prefer an admin tied to the from-email domain for the
    // best attribution; otherwise fall back to the seeded sentinel
    // service-account user so the failure row always lands and stays
    // visible on /admin/email-failures.
    //
    // Email comparison normalizes case: every DB email row is stored
    // lowercase (entra-provisioning and breakglass both lowercase at
    // insert time), so callers passing mixed-case fromEmail would
    // otherwise silently fail to attribute the send.
    if (!fromUserId) {
      const normalizedFrom = args.fromEmail.toLowerCase();
      const [u] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, normalizedFrom))
        .limit(1);
      if (u) {
        fromUserId = u.id;
        fromUserEmailSnapshot = u.email;
      }
    }
    if (!fromUserId) {
      fromUserId = SYSTEM_SENTINEL_USER_ID;
      fromUserEmailSnapshot = SYSTEM_SENTINEL_USER_EMAIL;
      logger.warn("marketing.email_send_log.attributed_to_sentinel", {
        feature: args.feature,
        fromEmail: args.fromEmail,
        toEmail: args.toEmail,
      });
    }
    await db.insert(emailSendLog).values({
      fromUserId,
      fromUserEmailSnapshot,
      toEmail: args.toEmail,
      feature: args.feature,
      featureRecordId: args.featureRecordId,
      subject: args.subject,
      hasAttachments: false,
      attachmentCount: 0,
      status: "failed",
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      httpStatus: args.httpStatus,
      durationMs: args.durationMs,
    });
  } catch (err) {
    logger.error("marketing.email_send_log.insert_failed", {
      feature: args.feature,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * SendGrid send pipeline.
 *
 * Two paths:
 * 1. `sendCampaign(id)` — fans the campaign template out to every
 * list_member that isn't suppressed. Caller transitions the row to
 * `sending` first; this fn enforces it.
 * 2. `sendTestEmail({...})` — single-recipient inline-HTML send used
 * by the template-editor "test send" button.
 *
 * The webhook receiver (`webhook.ts`) reconciles `x-message-id` →
 * `recipient_id` via custom_args we set on each personalization, so the
 * recipient rows we insert here begin with `sendgridMessageId: null`.
 *
 * Sandbox mode: `SENDGRID_SANDBOX=true` (dev / staging) makes every
 * /v3/mail/send call a no-op at SendGrid's edge — payload is validated
 * but no message is actually delivered. We still walk the full code
 * path so the dry-run exercises every join, audit, and counter update.
 */

const BATCH_SIZE = 1000;

export interface SendCampaignResult {
  batchId: string;
  recipientsAttempted: number;
  recipientsAccepted: number;
  recipientsFiltered: number;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  templateId: string;
  listId: string;
  fromEmail: string;
  fromName: string;
  replyToEmail: string | null;
  totalRecipients: number;
  totalSent: number;
  createdById: string;
}

interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  sendgridTemplateId: string | null;
}

/**
 * leadId is nullable so static-imported list members can
 * flow through the same send path. The `rowKey` getter below produces
 * a stable lookup key for the recipientByLead map (formerly keyed
 * solely on leadId).
 */
interface RecipientCandidate {
  leadId: string | null;
  email: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
}

/**
 * Stable key for mapping a candidate row to its inserted
 * `marketing_campaign_recipients` row. Uses leadId when available
 * (dynamic-list path) and falls back to email (static-imported path).
 * Within a single campaign send, both leadId and email are unique
 * within the candidate set so the key collision risk is nil.
 */
function recipientKey(c: { leadId: string | null; email: string }): string {
  return c.leadId ?? `email:${c.email.toLowerCase()}`;
}

/**
 * Send a campaign that has already been transitioned to status='sending'.
 *
 * Throws `ValidationError` for any non-recoverable precondition mismatch
 * (campaign missing, wrong status, template not pushed, list empty).
 * On terminal SendGrid failure, marks the campaign `failed` + audits
 * `marketing.campaign.send_failed` and rethrows so the cron can record
 * the per-campaign failure without poisoning the others.
 */
export async function sendCampaign(
  campaignId: string,
): Promise<SendCampaignResult> {
  const batchId = `cmp_${campaignId}_${Date.now().toString(36)}`;

  // F-Ω-1: the cron transitions status -> 'sending' atomically BEFORE
  // calling sendCampaign, so once we are inside this function the row
  // is observably in-flight. Any throw from the pre-batch region below
  // (loadCampaignContext, status assertion, template assertion,
  // resolveListRecipients, the SEND_STARTED audit, insertRecipientRows,
  // the totalAttempted===0 shortcut path) used to leave the campaign
  // permanently stuck in 'sending' — the cron's catch block only logs,
  // the next cron tick selects only 'scheduled' rows, and no other code
  // path resets 'sending'. Wrap the pre-batch region in a try/catch
  // that flips the row to 'failed' on the way out so a stuck row can
  // never accumulate. The inner try/catch (around the batch loop)
  // already handles failures from that point forward; this guard fires
  // only when a pre-batch step fails and falls through to the rethrow.
  let resolved: Awaited<ReturnType<typeof resolveListRecipients>>;
  let campaign: CampaignRow;
  let template: TemplateRow;
  try {
    const ctx = await loadCampaignContext(campaignId);
    if (!ctx) {
      throw new ValidationError("Campaign not found.");
    }
    campaign = ctx.campaign;
    template = ctx.template;

    if (campaign.status !== "sending") {
      throw new ValidationError(
        `Campaign is in status '${campaign.status}'; expected 'sending'.`,
      );
    }
    if (!template.sendgridTemplateId) {
      throw new ValidationError(
        "Template has not been pushed to SendGrid yet. Re-save the template before sending.",
      );
    }

    // unified resolution. `resolveListRecipients` branches
    // on `marketing_lists.list_type`: dynamic lists join through
    // `marketing_list_members` + leads; static lists pull directly from
    // `marketing_static_list_members`. Both paths filter suppressions at
    // the SQL layer.
    resolved = await resolveListRecipients(campaign.listId);
  } catch (err) {
    await markStuckSendingFailed(campaignId, batchId, err, "load");
    throw err;
  }
  const candidateRows: RecipientCandidate[] = resolved.recipients.map((r) => ({
    leadId: r.leadId,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    companyName: r.companyName,
    jobTitle: r.jobTitle,
    city: r.city,
    state: r.state,
  }));

  const totalAttempted = candidateRows.length;
  const totalFiltered = Math.max(
    0,
    campaign.totalRecipients - totalAttempted,
  );

  // F-Ω-1 (continued): the SEND_STARTED audit + totalAttempted===0
  // shortcut + insertRecipientRows are still pre-batch. Same recovery
  // policy: any throw here flips the row to 'failed' so a stuck row
  // can't accumulate.
  let inserted: Awaited<ReturnType<typeof insertRecipientRows>>;
  try {
    // Audit start before any batch fans out.
    await writeAudit({
      actorId: campaign.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_STARTED,
      targetType: "marketing_campaign",
      targetId: campaign.id,
      after: {
        batchId,
        totalRecipients: campaign.totalRecipients,
        totalAttempted,
        totalFiltered,
        sandbox: env.SENDGRID_SANDBOX,
      },
    });

    if (totalAttempted === 0) {
      // Nothing to send. Mark as sent (no-op) and audit completion. Avoid
      // calling SendGrid at all so we don't burn a no-op API hit.
      await db
        .update(marketingCampaigns)
        .set({
          status: "sent",
          sentAt: sql`now()`,
          totalSent: 0,
          updatedAt: sql`now()`,
        })
        .where(eq(marketingCampaigns.id, campaign.id));
      await writeAudit({
        actorId: campaign.createdById,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_COMPLETED,
        targetType: "marketing_campaign",
        targetId: campaign.id,
        after: {
          batchId,
          recipientsAttempted: 0,
          recipientsAccepted: 0,
          recipientsFiltered: totalFiltered,
        },
      });
      return {
        batchId,
        recipientsAttempted: 0,
        recipientsAccepted: 0,
        recipientsFiltered: totalFiltered,
      };
    }

    // Insert recipient rows up-front with `sendgridMessageId: null`. The
    // webhook receiver reconciles back to these rows via custom_args
    // (recipient_id) on each event.
    inserted = await insertRecipientRows(campaign.id, candidateRows);
  } catch (err) {
    await markStuckSendingFailed(campaignId, batchId, err, "prepare");
    throw err;
  }

  // Build a rowKey → recipientId map so personalizations can carry
  // custom_args.recipient_id for webhook reconciliation.
  // key is leadId for dynamic-list rows, `email:<lowercase>` for
  // static-imported rows (which have no lead row backing them).
  const recipientByLead = new Map<string, string>();
  for (const row of inserted) {
    recipientByLead.set(row.rowKey, row.id);
  }

  let totalAccepted = 0;
  // Track the slice currently in flight so the outer catch can write a
  // representative `email_send_log` row for the failing batch.
  let failingSlice: RecipientCandidate[] | null = null;
  const batchStart = { ts: Date.now() };
  try {
    for (let i = 0; i < candidateRows.length; i += BATCH_SIZE) {
      const slice = candidateRows.slice(i, i + BATCH_SIZE);
      failingSlice = slice;
      batchStart.ts = Date.now();
      const acceptedInBatch = await sendBatch({
        campaign,
        template,
        recipients: slice,
        recipientByLead,
      });
      totalAccepted += acceptedInBatch;
      failingSlice = null;

      // Roll the batch's recipients forward from `queued` → `sent`.
      // The schema-level fix replaces the prior bug where rows were
      // marked `sent` BEFORE the API call (so a failed send left
      // recipients incorrectly stamped).
      const slicedRecipientIds = slice
        .map((c) => recipientByLead.get(recipientKey(c)))
        .filter((id): id is string => typeof id === "string");
      await markRecipientsSent(slicedRecipientIds);

      // Bump totalSent atomically per batch so the realtime UI shows
      // progress. This is independent of webhook-driven `total_delivered`
      // counters (which arrive after SendGrid actually delivers).
      await db
        .update(marketingCampaigns)
        .set({
          totalSent: sql`${marketingCampaigns.totalSent} + ${acceptedInBatch}`,
          updatedAt: sql`now()`,
        })
        .where(eq(marketingCampaigns.id, campaign.id));
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("sendgrid.campaign.send_failed", {
      campaignId: campaign.id,
      batchId,
      errorMessage,
    });

    // Best-effort: surface the SendGrid API rejection on the admin
    // failures dashboard. ONE row per failed API call (per-recipient
    // delivery is tracked via marketing_email_events from the webhook).
    if (failingSlice && failingSlice.length > 0) {
      const sgErr = err as {
        code?: number;
        response?: { body?: unknown };
      };
      const detail = readSendGridErrorDetail(sgErr.response?.body);
      const httpStatus =
        typeof sgErr.code === "number" ? sgErr.code : null;
      const headerEmail =
        failingSlice.length > 1
          ? `${failingSlice[0].email} (+${failingSlice.length - 1} more)`
          : failingSlice[0].email;
      await logMarketingSendFailure({
        feature: FEATURE_CAMPAIGN_SEND,
        featureRecordId: campaign.id,
        fromUserId: campaign.createdById,
        fromEmail: campaign.fromEmail,
        toEmail: headerEmail,
        subject: template.subject,
        errorCode:
          httpStatus !== null
            ? `SENDGRID_${httpStatus}`
            : "SENDGRID_ERROR",
        errorMessage: detail ?? errorMessage,
        httpStatus,
        durationMs: Date.now() - batchStart.ts,
      });

      // Roll the failing batch's recipients forward from `queued` →
      // `dropped` with the SendGrid error as bounceReason. Recipients
      // in batches not yet attempted stay `queued` (accurate: never
      // sent). Recipients in successfully-sent earlier batches are
      // already `sent` via markRecipientsSent above.
      const failedRecipientIds = failingSlice
        .map((c) => recipientByLead.get(recipientKey(c)))
        .filter((id): id is string => typeof id === "string");
      await markRecipientsDropped(
        failedRecipientIds,
        detail ?? errorMessage,
      );
    }

    await db
      .update(marketingCampaigns)
      .set({
        status: "failed",
        failureReason: truncateForColumn(errorMessage, 500),
        updatedAt: sql`now()`,
      })
      .where(eq(marketingCampaigns.id, campaign.id));
    await writeAudit({
      actorId: campaign.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_FAILED,
      targetType: "marketing_campaign",
      targetId: campaign.id,
      after: {
        batchId,
        recipientsAttempted: totalAttempted,
        recipientsAccepted: totalAccepted,
        errorMessage: truncateForColumn(errorMessage, 500),
      },
    });
    throw err;
  }

  // Mark sent if every recipient was accepted by SendGrid. If sandbox
  // mode is on, treat sandbox-success as a normal completion — the
  // counters stay 0 in production semantics but the campaign lifecycle
  // still ends cleanly.
  await db
    .update(marketingCampaigns)
    .set({
      status: "sent",
      sentAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(marketingCampaigns.id, campaign.id));

  await writeAudit({
    actorId: campaign.createdById,
    action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_COMPLETED,
    targetType: "marketing_campaign",
    targetId: campaign.id,
    after: {
      batchId,
      recipientsAttempted: totalAttempted,
      recipientsAccepted: totalAccepted,
      recipientsFiltered: totalFiltered,
      sandbox: env.SENDGRID_SANDBOX,
    },
  });

  return {
    batchId,
    recipientsAttempted: totalAttempted,
    recipientsAccepted: totalAccepted,
    recipientsFiltered: totalFiltered,
  };
}

/**
 * Single-recipient diagnostic send. Two callable shapes — both ship in
 * because they cover separate consumers:
 *
 * "raw" shape: caller already has rendered HTML + a subject + the
 * fromName they want stamped (template-editor preview, admin
 * endpoint with arbitrary HTML).
 *
 * "template" shape: caller passes `templateId` + `recipientEmail`
 * + `actorUserId`; we look up the stored template and use its
 * subject + rendered HTML, attributing the audit/log line to the
 * actor. Used by the marketing template-detail "Send Test" button
 * so the operator doesn't have to re-paste HTML.
 *
 * Neither shape goes through SendGrid Dynamic Templates — the editor's
 * working copy may not have been pushed yet, and we want the test to
 * reflect the exact HTML the operator just clicked Send Test on.
 */
export interface SendTestEmailRawInput {
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  html: string;
  fromName: string;
  /**
   * Optional — when provided, terminal SendGrid failures are written to
   * `email_send_log` so they surface on the admin failures dashboard.
   * Omit only when no user context is available.
   */
  actorUserId?: string;
  /**
   * Optional — opaque pointer to the related entity (template id,
   * campaign id) for cross-reference in the failures dashboard.
   */
  featureRecordId?: string;
}

export interface SendTestEmailTemplateInput {
  templateId: string;
  recipientEmail: string;
  actorUserId: string;
  /** Optional override for the displayed sender name. */
  fromName?: string;
}

export type SendTestEmailInput =
  | SendTestEmailRawInput
  | SendTestEmailTemplateInput;

function isTemplateInput(
  input: SendTestEmailInput,
): input is SendTestEmailTemplateInput {
  return "templateId" in input;
}

export async function sendTestEmail(
  input: SendTestEmailInput,
): Promise<{ messageId: string }> {
  if (isTemplateInput(input)) {
    const [tpl] = await db
      .select({
        id: marketingTemplates.id,
        subject: marketingTemplates.subject,
        renderedHtml: marketingTemplates.renderedHtml,
        isDeleted: marketingTemplates.isDeleted,
      })
      .from(marketingTemplates)
      .where(eq(marketingTemplates.id, input.templateId))
      .limit(1);
    if (!tpl || tpl.isDeleted) {
      throw new ValidationError("Template not found.");
    }
    // Fresh templates seed renderedHtml as ''; SendGrid rejects empty
    // /v3/mail/send content with HTTP 400. Fail fast with a clear
    // instruction so the user knows to save the design first.
    if (tpl.renderedHtml.trim().length === 0) {
      throw new ValidationError(
        "Save the design before sending a test — this template has no rendered HTML yet.",
      );
    }
    if (tpl.subject.trim().length === 0) {
      throw new ValidationError(
        "Set a subject before sending a test.",
      );
    }
    return sendRawTest({
      recipientEmail: input.recipientEmail,
      subject: tpl.subject,
      html: tpl.renderedHtml,
      fromName: input.fromName ?? env.SENDGRID_FROM_NAME_DEFAULT,
      actorUserId: input.actorUserId,
      featureRecordId: input.templateId,
    });
  }
  return sendRawTest(input);
}

async function sendRawTest(
  input: SendTestEmailRawInput,
): Promise<{ messageId: string }> {
  const { sgMail } = getSendGrid();
  const fromEmail = `noreply@${env.SENDGRID_FROM_DOMAIN}`;
  // Stamp the test-send personalization with enough custom_args
  // for webhook events to be correlated back to (operator, template,
  // entity) tuples. Test sends do NOT insert a `campaignRecipients`
  // row, so the webhook receiver's recipient_id lookup will fail —
  // the forensic row in `marketing_email_events` still gets these
  // custom_args via `rawPayload`, giving operators a way to answer
  // "did my test send deliver / open / click?" by querying the
  // events table directly.
  const testCustomArgs: Record<string, string> = {
    source: "marketing_test_send",
  };
  if (input.actorUserId) testCustomArgs.actor_user_id = input.actorUserId;
  if (input.featureRecordId)
    testCustomArgs.template_id = input.featureRecordId;
  const payload = {
    from: { email: fromEmail, name: input.fromName },
    personalizations: [
      {
        to: [
          input.recipientName
            ? { email: input.recipientEmail, name: input.recipientName }
            : { email: input.recipientEmail },
        ],
        custom_args: testCustomArgs,
      },
    ],
    subject: input.subject,
    content: [{ type: "text/html", value: input.html }],
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
    },
    mail_settings: {
      sandbox_mode: { enable: env.SENDGRID_SANDBOX },
    },
  };
  const sendStart = Date.now();
  let messageId: string;
  try {
    messageId = await withRetry(async () => {
      // The sendgrid types want a `MailDataRequired` shape from a
      // helper package that isn't shipped at runtime. Cast to the
      // library's expected parameter without smuggling `any` into the
      // module — `Parameters<typeof sgMail.send>[0]` infers the right
      // structural type and gives us a precise downcast.
      type SgSendResult = Awaited<ReturnType<typeof sgMail.send>>;
      let response: SgSendResult[0];
      try {
        [response] = await sgMail.send(
          payload as unknown as Parameters<typeof sgMail.send>[0],
        );
      } catch (err) {
        // @sendgrid/mail throws on 4xx/5xx; the bare error message is
        // just the HTTP statusText ("Bad Request"), which is opaque to
        // both the user and the operator. Pull the structured detail
        // out of `err.response.body.errors[]` so the log line — and the
        // user-visible publicMessage on a 4xx — points at the actual
        // reason (e.g. "content must contain at least one character").
        const sgErr = err as {
          code?: number;
          response?: { body?: unknown };
          message?: string;
        };
        const detail = readSendGridErrorDetail(sgErr.response?.body);
        const status = typeof sgErr.code === "number" ? sgErr.code : null;
        logger.warn("sendgrid.send.failed", {
          statusCode: status,
          detail,
          rawMessage: sgErr.message,
        });
        if (status !== null && status >= 400 && status < 500 && status !== 429) {
          throw new ValidationError(
            detail
              ? `SendGrid rejected the message: ${detail}`
              : "SendGrid rejected the message. Check the recipient address and template content.",
          );
        }
        // Let withRetry decide on 5xx / 429 / network errors.
        throw err;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw asSendGridError(response.statusCode, response.body);
      }
      const headerMessageId = readMessageIdHeader(response.headers);
      if (headerMessageId === null) {
        // SendGrid /v3/mail/send always returns x-message-id on 2xx;
        // a null here means a CDN stripped the header, a proxy
        // rewrote the response, or SendGrid's contract changed. Audit
        // a synthetic placeholder so the anomaly is visible rather
        // than silently logging an empty messageId.
        logger.warn("sendgrid.send.missing_message_id_header", {
          statusCode: response.statusCode,
          recipient: input.recipientEmail,
        });
        return "missing-message-id";
      }
      return headerMessageId;
    });
  } catch (err) {
    // Terminal failure (4xx ValidationError or retries-exhausted 5xx).
    // Best-effort log to email_send_log so admins see it on the
    // failures dashboard.
    const sgErr = err as {
      code?: number;
      response?: { body?: unknown };
      message?: string;
    };
    const detail = readSendGridErrorDetail(sgErr.response?.body);
    const httpStatus = typeof sgErr.code === "number" ? sgErr.code : null;
    await logMarketingSendFailure({
      feature: FEATURE_TEST_SEND,
      featureRecordId: input.featureRecordId ?? null,
      fromUserId: input.actorUserId ?? null,
      fromEmail,
      toEmail: input.recipientEmail,
      subject: input.subject,
      errorCode:
        httpStatus !== null
          ? `SENDGRID_${httpStatus}`
          : "SENDGRID_ERROR",
      errorMessage:
        detail ??
        (err instanceof Error ? err.message : String(err)),
      httpStatus,
      durationMs: Date.now() - sendStart,
    });
    throw err;
  }
  return { messageId };
}

function readSendGridErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] as { message?: unknown; field?: unknown };
  if (typeof first?.message !== "string") return null;
  const field = typeof first.field === "string" ? ` (${first.field})` : "";
  return `${first.message}${field}`;
}

/**
 * F-Ω-1: best-effort transition of a 'sending' campaign back to
 * 'failed' when sendCampaign's pre-batch region throws.
 *
 * Without this, a throw from loadCampaignContext / status assertion /
 * resolveListRecipients / SEND_STARTED audit / insertRecipientRows
 * leaves the row stuck in 'sending'. The cron's catch only logs; the
 * next cron tick selects only 'scheduled' rows; no other code path
 * recovers a stuck 'sending'. The campaign becomes permanently
 * un-restartable from the UI (also can't go scheduled -> sending
 * because it's already sending).
 *
 * Failure to flip is logged but never blocks the rethrow — the caller's
 * error is what matters. A future repair sweep or admin tool can
 * recover orphan-sending rows if the failure_reason update itself fails.
 *
 * `phase` is a short label distinguishing which pre-batch step threw
 * ("load" / "prepare") so operators can correlate the structured log
 * with the originating block.
 */
async function markStuckSendingFailed(
  campaignId: string,
  batchId: string,
  err: unknown,
  phase: "load" | "prepare",
): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  logger.error("sendgrid.campaign.pre_batch_failed", {
    campaignId,
    batchId,
    phase,
    errorMessage,
  });
  try {
    await db
      .update(marketingCampaigns)
      .set({
        status: "failed",
        failureReason: truncateForColumn(errorMessage, 500),
        updatedAt: sql`now()`,
      })
      .where(eq(marketingCampaigns.id, campaignId));
  } catch (updateErr) {
    logger.error("sendgrid.campaign.pre_batch_status_reset_failed", {
      campaignId,
      batchId,
      phase,
      errorMessage:
        updateErr instanceof Error ? updateErr.message : String(updateErr),
    });
  }
}

async function loadCampaignContext(
  campaignId: string,
): Promise<{ campaign: CampaignRow; template: TemplateRow } | null> {
  const [campaignRow] = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      templateId: marketingCampaigns.templateId,
      listId: marketingCampaigns.listId,
      fromEmail: marketingCampaigns.fromEmail,
      fromName: marketingCampaigns.fromName,
      replyToEmail: marketingCampaigns.replyToEmail,
      totalRecipients: marketingCampaigns.totalRecipients,
      totalSent: marketingCampaigns.totalSent,
      createdById: marketingCampaigns.createdById,
      isDeleted: marketingCampaigns.isDeleted,
      listIsDeleted: marketingLists.isDeleted,
    })
    .from(marketingCampaigns)
    .leftJoin(
      marketingLists,
      eq(marketingLists.id, marketingCampaigns.listId),
    )
    .where(eq(marketingCampaigns.id, campaignId))
    .limit(1);
  if (!campaignRow || campaignRow.isDeleted) return null;
  if (campaignRow.listIsDeleted) {
    throw new ValidationError("Campaign list has been archived.");
  }
  // campaign.templateId is now nullable: a draft can
  // be left dangling after a personal-template delete. The send path
  // explicitly refuses dangling campaigns (an unlinked draft can't
  // reach 'scheduled' through the wizard either, but the validation
  // here is the last defense).
  if (!campaignRow.templateId) {
    throw new ValidationError(
      "Campaign has no template. Pick one before sending.",
    );
  }

  const [templateRow] = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      subject: marketingTemplates.subject,
      sendgridTemplateId: marketingTemplates.sendgridTemplateId,
      isDeleted: marketingTemplates.isDeleted,
    })
    .from(marketingTemplates)
    .where(eq(marketingTemplates.id, campaignRow.templateId))
    .limit(1);
  if (!templateRow || templateRow.isDeleted) {
    throw new ValidationError("Campaign template has been archived.");
  }

  return {
    campaign: {
      id: campaignRow.id,
      name: campaignRow.name,
      status: campaignRow.status,
      templateId: campaignRow.templateId,
      listId: campaignRow.listId,
      fromEmail: campaignRow.fromEmail,
      fromName: campaignRow.fromName,
      replyToEmail: campaignRow.replyToEmail,
      totalRecipients: campaignRow.totalRecipients,
      totalSent: campaignRow.totalSent,
      createdById: campaignRow.createdById,
    },
    template: {
      id: templateRow.id,
      name: templateRow.name,
      subject: templateRow.subject,
      sendgridTemplateId: templateRow.sendgridTemplateId,
    },
  };
}

async function insertRecipientRows(
  campaignId: string,
  candidates: RecipientCandidate[],
): Promise<{ id: string; rowKey: string }[]> {
  const out: { id: string; rowKey: string }[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const slice = candidates.slice(i, i + BATCH_SIZE);
    // Recipients enter `queued` — the canonical pre-send state. Rolled
    // forward to `sent` (with sentAt) on successful batch send, or to
    // `dropped` (with bounceReason) if SendGrid rejects the batch.
    // Previously this insert wrote `sent` upfront which left
    // recipients incorrectly stamped if the subsequent send failed.
    //
    // snapshot the merge data at queue-time. Once
    // queued, subsequent edits to the source lead (rename, company
    // change) do NOT affect what this recipient receives. The send
    // batch reads from snapshot_merge_data.
    //
    // leadId may be null for static-imported list
    // members (no lead row backs them). The campaignRecipients schema
    // already allows nullable leadId; the rowKey returned below uses
    // email-based fallback when leadId is null so the in-memory
    // recipientByLead map stays consistent across both source types.
    const inserted = await db
      .insert(campaignRecipients)
      .values(
        slice.map((c) => ({
          campaignId,
          leadId: c.leadId,
          email: c.email,
          status: "queued" as const,
          snapshotMergeData: buildMergeData(c),
        })),
      )
      .returning({
        id: campaignRecipients.id,
        leadId: campaignRecipients.leadId,
        email: campaignRecipients.email,
      });
    for (const row of inserted) {
      out.push({
        id: row.id,
        rowKey: recipientKey({ leadId: row.leadId, email: row.email }),
      });
    }
  }
  return out;
}

/**
 * Roll forward a batch of recipients to `sent` after SendGrid
 * accepted the API call. Best-effort: log + continue on failure —
 * the webhook reconciliation still updates delivery state via
 * custom_args.recipient_id.
 */
async function markRecipientsSent(recipientIds: string[]): Promise<void> {
  if (recipientIds.length === 0) return;
  try {
    await db
      .update(campaignRecipients)
      .set({ status: "sent", sentAt: new Date() })
      .where(inArray(campaignRecipients.id, recipientIds));
  } catch (err) {
    logger.error("marketing.send.mark_sent_failed", {
      recipientCount: recipientIds.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Roll forward a batch of recipients to `dropped` after the SendGrid
 * API call threw. SendGrid never accepted the message — `dropped` is
 * the matching status in their event taxonomy.
 */
async function markRecipientsDropped(
  recipientIds: string[],
  reason: string,
): Promise<void> {
  if (recipientIds.length === 0) return;
  try {
    await db
      .update(campaignRecipients)
      .set({
        status: "dropped",
        bounceReason: reason.slice(0, 500),
        bouncedAt: new Date(),
      })
      .where(inArray(campaignRecipients.id, recipientIds));
  } catch (err) {
    logger.error("marketing.send.mark_dropped_failed", {
      recipientCount: recipientIds.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

interface SendBatchInput {
  campaign: CampaignRow;
  template: TemplateRow;
  recipients: RecipientCandidate[];
  recipientByLead: Map<string, string>;
}

async function sendBatch(input: SendBatchInput): Promise<number> {
  if (input.recipients.length === 0) return 0;
  const { sgMail } = getSendGrid();
  const personalizations = input.recipients.map((r) => {
    const recipientId = input.recipientByLead.get(recipientKey(r)) ?? "";
    return {
      to: [{ email: r.email }],
      dynamic_template_data: buildMergeData(r),
      custom_args: {
        campaign_id: input.campaign.id,
        recipient_id: recipientId,
        // leadId may be null for static-imported
        // recipients. Webhook reconciliation uses recipient_id; lead_id
        // is informational.
        lead_id: r.leadId ?? "",
      },
    };
  });

  const payload: Record<string, unknown> = {
    from: { email: input.campaign.fromEmail, name: input.campaign.fromName },
    template_id: input.template.sendgridTemplateId,
    personalizations,
    tracking_settings: {
      click_tracking: { enable: true, enable_text: true },
      open_tracking: { enable: true },
    },
    mail_settings: {
      sandbox_mode: { enable: env.SENDGRID_SANDBOX },
    },
  };
  if (input.campaign.replyToEmail) {
    payload.reply_to = { email: input.campaign.replyToEmail };
  }
  if (env.SENDGRID_UNSUBSCRIBE_GROUP_ID !== undefined) {
    payload.asm = { group_id: env.SENDGRID_UNSUBSCRIBE_GROUP_ID };
  }

  await withRetry(async () => {
    const [response] = await sgMail.send(
      payload as unknown as Parameters<typeof sgMail.send>[0],
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw asSendGridError(response.statusCode, response.body);
    }
  });

  return input.recipients.length;
}

function buildMergeData(
  recipient: RecipientCandidate,
): Record<string, string> {
  const firstName = recipient.firstName ?? "";
  const lastName = recipient.lastName ?? "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return {
    firstName,
    lastName,
    fullName,
    email: recipient.email,
    companyName: recipient.companyName ?? "",
    jobTitle: recipient.jobTitle ?? "",
    city: recipient.city ?? "",
    state: recipient.state ?? "",
  };
}

function readMessageIdHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== "object") return null;
  // SendGrid returns headers as a plain object on the response object.
  // The header name is `x-message-id` (lowercase).
  const h = headers as Record<string, string | string[] | undefined>;
  const value = h["x-message-id"] ?? h["X-Message-Id"];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function truncateForColumn(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function asSendGridError(httpStatus: number, body: unknown): Error & {
  code: number;
  response: { body: unknown };
} {
  const err = new Error(
    `SendGrid API error: HTTP ${httpStatus}`,
  ) as Error & { code: number; response: { body: unknown } };
  err.code = httpStatus;
  err.response = { body };
  return err;
}

