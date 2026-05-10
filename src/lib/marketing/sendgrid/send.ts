import "server-only";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import {
  marketingListMembers,
  marketingLists,
} from "@/db/schema/marketing-lists";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { withRetry } from "@/lib/marketing/with-retry";
import { getSendGrid } from "./client";

/**
 * Phase 21 — SendGrid send pipeline.
 *
 * Two paths:
 *   1. `sendCampaign(id)` — fans the campaign template out to every
 *      list_member that isn't suppressed. Caller transitions the row to
 *      `sending` first; this fn enforces it.
 *   2. `sendTestEmail({...})` — single-recipient inline-HTML send used
 *      by the template-editor "test send" button.
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

interface RecipientCandidate {
  leadId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
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

  const ctx = await loadCampaignContext(campaignId);
  if (!ctx) {
    throw new ValidationError("Campaign not found.");
  }
  const { campaign, template } = ctx;

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

  // Filter suppressions inline via NOT IN subquery — Drizzle expression,
  // not a raw SQL string.
  const suppressedSubq = db
    .select({ email: marketingSuppressions.email })
    .from(marketingSuppressions);

  const candidateRows: RecipientCandidate[] = await db
    .select({
      leadId: leads.id,
      email: marketingListMembers.email,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      jobTitle: leads.jobTitle,
      city: leads.city,
      state: leads.state,
    })
    .from(marketingListMembers)
    .innerJoin(leads, eq(leads.id, marketingListMembers.leadId))
    .where(
      and(
        eq(marketingListMembers.listId, campaign.listId),
        eq(leads.isDeleted, false),
        eq(leads.doNotEmail, false),
        notInArray(marketingListMembers.email, suppressedSubq),
      ),
    );

  const totalAttempted = candidateRows.length;
  const totalFiltered = Math.max(
    0,
    campaign.totalRecipients - totalAttempted,
  );

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
  const inserted = await insertRecipientRows(campaign.id, candidateRows);

  // Build a leadId → recipientId map so personalizations can carry
  // custom_args.recipient_id for webhook reconciliation.
  const recipientByLead = new Map<string, string>();
  for (const row of inserted) {
    recipientByLead.set(row.leadId, row.id);
  }

  let totalAccepted = 0;
  try {
    for (let i = 0; i < candidateRows.length; i += BATCH_SIZE) {
      const slice = candidateRows.slice(i, i + BATCH_SIZE);
      const acceptedInBatch = await sendBatch({
        campaign,
        template,
        recipients: slice,
        recipientByLead,
      });
      totalAccepted += acceptedInBatch;

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
 * Phase 21 because they cover separate consumers:
 *
 *   - "raw" shape: caller already has rendered HTML + a subject + the
 *     fromName they want stamped (template-editor preview, admin
 *     endpoint with arbitrary HTML).
 *
 *   - "template" shape: caller passes `templateId` + `recipientEmail`
 *     + `actorUserId`; we look up the stored template and use its
 *     subject + rendered HTML, attributing the audit/log line to the
 *     actor. Used by the marketing template-detail "Send Test" button
 *     so the operator doesn't have to re-paste HTML.
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
    return sendRawTest({
      recipientEmail: input.recipientEmail,
      subject: tpl.subject,
      html: tpl.renderedHtml,
      fromName: input.fromName ?? env.SENDGRID_FROM_NAME_DEFAULT,
    });
  }
  return sendRawTest(input);
}

async function sendRawTest(
  input: SendTestEmailRawInput,
): Promise<{ messageId: string }> {
  const { sgMail } = getSendGrid();
  const fromEmail = `noreply@${env.SENDGRID_FROM_DOMAIN}`;
  const payload = {
    from: { email: fromEmail, name: input.fromName },
    personalizations: [
      {
        to: [
          input.recipientName
            ? { email: input.recipientEmail, name: input.recipientName }
            : { email: input.recipientEmail },
        ],
        custom_args: { source: "marketing_test_send" },
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
  const messageId = await withRetry(async () => {
    // The sendgrid types want a `MailDataRequired` shape from a
    // helper package that isn't shipped at runtime. Cast to the
    // library's expected parameter without smuggling `any` into the
    // module — `Parameters<typeof sgMail.send>[0]` infers the right
    // structural type and gives us a precise downcast.
    const [response] = await sgMail.send(
      payload as unknown as Parameters<typeof sgMail.send>[0],
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw asSendGridError(response.statusCode, response.body);
    }
    return readMessageIdHeader(response.headers) ?? "";
  });
  return { messageId };
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
): Promise<{ id: string; leadId: string }[]> {
  const out: { id: string; leadId: string }[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const slice = candidates.slice(i, i + BATCH_SIZE);
    const inserted = await db
      .insert(campaignRecipients)
      .values(
        slice.map((c) => ({
          campaignId,
          leadId: c.leadId,
          email: c.email,
          status: "sent" as const,
          sentAt: new Date(),
        })),
      )
      .returning({
        id: campaignRecipients.id,
        leadId: campaignRecipients.leadId,
      });
    for (const row of inserted) {
      // `leadId` is nullable in the schema but always set here.
      if (row.leadId) {
        out.push({ id: row.id, leadId: row.leadId });
      }
    }
  }
  return out;
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
    const recipientId = input.recipientByLead.get(r.leadId) ?? "";
    return {
      to: [{ email: r.email }],
      dynamic_template_data: buildMergeData(r),
      custom_args: {
        campaign_id: input.campaign.id,
        recipient_id: recipientId,
        lead_id: r.leadId,
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

