"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env, sendgridConfigured } from "@/lib/env";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { rateLimit } from "@/lib/security/rate-limit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
// Sub-agent A is delivering these. Importing as named so a missing
// module surfaces as a build-time error in this file rather than a
// silent runtime miss.
import { sendCampaign, sendTestEmail } from "@/lib/marketing/sendgrid/send";

/**
 * Phase 21 — Campaign composer + lifecycle actions.
 *
 * Lifecycle gates are enforced both here and at the API layer; either
 * surface (server action call from the wizard, or REST PUT/POST) hits
 * the same state machine. Audit events use the canonical names from
 * `MARKETING_AUDIT_EVENTS`.
 *
 * State machine:
 *   draft     → scheduled (scheduleCampaignAction)
 *   draft     → sending   (sendCampaignNowAction)
 *   draft     → cancelled (cancelCampaignAction)  // optional convenience
 *   draft     → deleted   (deleteCampaignAction)
 *   scheduled → sending   (sendCampaignNowAction; kicks off early)
 *   scheduled → cancelled (cancelCampaignAction)
 *   sending   → sent      (handled by sendCampaign; not via action)
 *   sending   → failed    (handled by sendCampaign; not via action)
 *   cancelled → deleted   (deleteCampaignAction)
 */

/* ------------------------------------------------------------------ */
/* Validation schemas                                                  */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid();

const campaignDraftCreateSchema = z.object({
  templateId: uuidSchema.optional(),
  listId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

const campaignDraftUpdateSchema = z.object({
  id: uuidSchema,
  name: z.string().trim().min(1).max(200).optional(),
  templateId: uuidSchema.optional(),
  listId: uuidSchema.optional(),
  fromEmail: z.string().email().max(254).optional(),
  fromName: z.string().trim().min(1).max(120).optional(),
  replyToEmail: z
    .string()
    .email()
    .max(254)
    .optional()
    .or(z.literal("")),
});

const campaignScheduleSchema = z.object({
  id: uuidSchema,
  scheduledFor: z
    .union([z.string(), z.date()])
    .transform((v) => (v instanceof Date ? v : new Date(v))),
});

const campaignTestSchema = z.object({
  id: uuidSchema,
  recipientEmail: z.string().email().max(254),
});

/* ------------------------------------------------------------------ */
/* Permission helper                                                   */
/* ------------------------------------------------------------------ */

async function requireMarketingPermission() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    throw new ForbiddenError(
      "You don't have permission to manage marketing campaigns.",
    );
  }
  return user;
}

async function loadCampaign(id: string) {
  const [row] = await db
    .select()
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.id, id))
    .limit(1);
  if (!row) throw new NotFoundError("campaign");
  return row;
}

/* ------------------------------------------------------------------ */
/* Create draft                                                        */
/* ------------------------------------------------------------------ */

export async function createCampaignDraftAction(input: {
  templateId?: string;
  listId?: string;
  name?: string;
}): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary(
    { action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CREATE },
    async () => {
      const user = await requireMarketingPermission();
      const parsed = campaignDraftCreateSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      // The DB requires a non-null template/list for a draft row to
      // satisfy NOT NULL constraints. The wizard's first step picks a
      // template before it ever calls this; if the wizard ever wants
      // to persist before that, it has to pick placeholder ids first.
      if (!parsed.data.templateId) {
        throw new ValidationError("Pick a template before saving the draft.");
      }
      if (!parsed.data.listId) {
        // Allow listId to be deferred — we use a sentinel "unselected"
        // by reusing the very first list the user has access to. But
        // schema requires non-null. Decision: require it at this layer
        // too. The wizard only calls this after step 2 of the flow.
        throw new ValidationError("Pick a list before saving the draft.");
      }

      // Validate the template + list exist and are not deleted.
      const [tpl] = await db
        .select({ id: marketingTemplates.id })
        .from(marketingTemplates)
        .where(
          and(
            eq(marketingTemplates.id, parsed.data.templateId),
            eq(marketingTemplates.isDeleted, false),
          ),
        )
        .limit(1);
      if (!tpl) throw new NotFoundError("template");

      const [list] = await db
        .select({ id: marketingLists.id, name: marketingLists.name })
        .from(marketingLists)
        .where(
          and(
            eq(marketingLists.id, parsed.data.listId),
            eq(marketingLists.isDeleted, false),
          ),
        )
        .limit(1);
      if (!list) throw new NotFoundError("list");

      const name =
        parsed.data.name?.trim() ||
        `Campaign — ${new Date().toISOString().slice(0, 10)}`;

      const [created] = await db
        .insert(marketingCampaigns)
        .values({
          name,
          templateId: parsed.data.templateId,
          listId: parsed.data.listId,
          fromEmail: `noreply@${env.SENDGRID_FROM_DOMAIN}`,
          fromName: env.SENDGRID_FROM_NAME_DEFAULT,
          status: "draft",
          createdById: user.id,
          updatedById: user.id,
        })
        .returning({ id: marketingCampaigns.id });

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CREATE,
        targetType: "marketing_campaign",
        targetId: created.id,
        after: {
          name,
          templateId: parsed.data.templateId,
          listId: parsed.data.listId,
        },
      });

      revalidatePath("/marketing/campaigns");
      return { id: created.id };
    },
  );
}

/* ------------------------------------------------------------------ */
/* Update draft                                                        */
/* ------------------------------------------------------------------ */

export async function updateCampaignDraftAction(input: {
  id: string;
  name?: string;
  templateId?: string;
  listId?: string;
  fromEmail?: string;
  fromName?: string;
  replyToEmail?: string;
}): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_UPDATE,
      entityType: "marketing_campaign",
      entityId: input.id,
    },
    async () => {
      const user = await requireMarketingPermission();
      const parsed = campaignDraftUpdateSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      const campaign = await loadCampaign(parsed.data.id);
      if (campaign.isDeleted) throw new NotFoundError("campaign");
      if (campaign.status !== "draft") {
        throw new ConflictError(
          "Only draft campaigns can be edited. Cancel the campaign to make changes.",
        );
      }

      const patch: Record<string, unknown> = { updatedById: user.id };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) {
        before.name = campaign.name;
        patch.name = parsed.data.name;
        after.name = parsed.data.name;
      }
      if (parsed.data.templateId !== undefined) {
        before.templateId = campaign.templateId;
        patch.templateId = parsed.data.templateId;
        after.templateId = parsed.data.templateId;
      }
      if (parsed.data.listId !== undefined) {
        before.listId = campaign.listId;
        patch.listId = parsed.data.listId;
        after.listId = parsed.data.listId;
      }
      if (parsed.data.fromEmail !== undefined) {
        before.fromEmail = campaign.fromEmail;
        patch.fromEmail = parsed.data.fromEmail;
        after.fromEmail = parsed.data.fromEmail;
      }
      if (parsed.data.fromName !== undefined) {
        before.fromName = campaign.fromName;
        patch.fromName = parsed.data.fromName;
        after.fromName = parsed.data.fromName;
      }
      if (parsed.data.replyToEmail !== undefined) {
        before.replyToEmail = campaign.replyToEmail;
        patch.replyToEmail =
          parsed.data.replyToEmail === "" ? null : parsed.data.replyToEmail;
        after.replyToEmail = patch.replyToEmail;
      }

      // Mass-assignment guard — only the fields above were copied to
      // `patch`. The rest of the row is untouched.
      await db
        .update(marketingCampaigns)
        .set({
          ...patch,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(marketingCampaigns.id, parsed.data.id),
            eq(marketingCampaigns.status, "draft"),
            eq(marketingCampaigns.isDeleted, false),
          ),
        );

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_UPDATE,
        targetType: "marketing_campaign",
        targetId: parsed.data.id,
        before,
        after,
      });

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsed.data.id}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

export async function scheduleCampaignAction(input: {
  id: string;
  scheduledFor: Date;
}): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SCHEDULE,
      entityType: "marketing_campaign",
      entityId: input.id,
    },
    async () => {
      const user = await requireMarketingPermission();
      const parsed = campaignScheduleSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError(
          "scheduledFor must be a valid future timestamp.",
        );
      }
      if (parsed.data.scheduledFor.getTime() <= Date.now()) {
        throw new ValidationError(
          "Scheduled time must be in the future.",
        );
      }

      const campaign = await loadCampaign(parsed.data.id);
      if (campaign.isDeleted) throw new NotFoundError("campaign");
      if (campaign.status !== "draft") {
        throw new ConflictError(
          "Only draft campaigns can be scheduled.",
        );
      }

      await db
        .update(marketingCampaigns)
        .set({
          status: "scheduled",
          scheduledFor: parsed.data.scheduledFor,
          updatedAt: new Date(),
          updatedById: user.id,
        })
        .where(
          and(
            eq(marketingCampaigns.id, parsed.data.id),
            eq(marketingCampaigns.status, "draft"),
            eq(marketingCampaigns.isDeleted, false),
          ),
        );

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SCHEDULE,
        targetType: "marketing_campaign",
        targetId: parsed.data.id,
        before: { status: campaign.status, scheduledFor: campaign.scheduledFor },
        after: {
          status: "scheduled",
          scheduledFor: parsed.data.scheduledFor.toISOString(),
        },
      });

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsed.data.id}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

export async function cancelCampaignAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CANCEL,
      entityType: "marketing_campaign",
      entityId: id,
    },
    async () => {
      const user = await requireMarketingPermission();
      const parsedId = uuidSchema.parse(id);

      const campaign = await loadCampaign(parsedId);
      if (campaign.isDeleted) throw new NotFoundError("campaign");
      if (campaign.status !== "scheduled" && campaign.status !== "draft") {
        throw new ConflictError(
          "Only draft or scheduled campaigns can be cancelled.",
        );
      }

      await db
        .update(marketingCampaigns)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
          updatedById: user.id,
        })
        .where(
          and(
            eq(marketingCampaigns.id, parsedId),
            eq(marketingCampaigns.isDeleted, false),
          ),
        );

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CANCEL,
        targetType: "marketing_campaign",
        targetId: parsedId,
        before: { status: campaign.status },
        after: { status: "cancelled" },
      });

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsedId}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Send now                                                            */
/* ------------------------------------------------------------------ */

export async function sendCampaignNowAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_STARTED,
      entityType: "marketing_campaign",
      entityId: id,
    },
    async () => {
      const user = await requireMarketingPermission();
      if (!sendgridConfigured) {
        throw new ValidationError(
          "SendGrid is not configured for this environment.",
        );
      }
      const parsedId = uuidSchema.parse(id);

      // Per-user hourly limiter — the API route enforces too, but this
      // path is a separate surface so we re-check here.
      const limit = await rateLimit(
        { kind: "campaign_send", principal: user.id },
        env.RATE_LIMIT_CAMPAIGN_SEND_PER_USER_PER_HOUR,
        60 * 60,
      );
      if (!limit.allowed) {
        throw new RateLimitError(
          "You've hit the campaign-send limit for the past hour. Try again later.",
        );
      }

      const campaign = await loadCampaign(parsedId);
      if (campaign.isDeleted) throw new NotFoundError("campaign");
      if (campaign.status !== "draft" && campaign.status !== "scheduled") {
        throw new ConflictError(
          "Only draft or scheduled campaigns can be sent now.",
        );
      }

      // Atomic claim — the WHERE clause guards BOTH:
      // (a) double-click from the same user (the in-flight first
      //     UPDATE has already flipped status to 'sending'),
      // (b) race with /api/cron/marketing-process-scheduled-campaigns,
      //     which uses the same conditional-UPDATE pattern on
      //     status='scheduled'. If the cron grabs the row first, our
      //     status moves from 'scheduled' to 'sending' and this
      //     WHERE clause won't match — we throw ConflictError instead
      //     of double-sending.
      const result = await db
        .update(marketingCampaigns)
        .set({
          status: "sending",
          updatedAt: new Date(),
          updatedById: user.id,
        })
        .where(
          and(
            eq(marketingCampaigns.id, parsedId),
            eq(marketingCampaigns.isDeleted, false),
            inArray(marketingCampaigns.status, ["draft", "scheduled"]),
          ),
        )
        .returning({ id: marketingCampaigns.id });

      if (result.length === 0) {
        // Either the campaign was deleted/aborted between the load
        // and the atomic claim, or another worker (cron / concurrent
        // user) already moved it past 'draft'/'scheduled'. Surface
        // distinctly from "missing" so the UI can render a
        // helpful retry-or-refresh message.
        throw new ConflictError(
          "Campaign is already being sent or is no longer eligible.",
        );
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_STARTED,
        targetType: "marketing_campaign",
        targetId: parsedId,
        before: { status: campaign.status },
        after: { status: "sending" },
      });

      // Kick off the send. sendCampaign returns when SendGrid has
      // accepted the batch (the webhook flips status to 'sent' /
      // 'failed' as deliveries complete). We don't await further —
      // bound by the sub-agent A contract.
      try {
        await sendCampaign(parsedId);
      } catch (err) {
        logger.error("campaign.send_failed", {
          campaignId: parsedId,
          actorId: user.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        // sendCampaign owns the failed-state audit + DB transition.
        // Re-throw so the action result reflects the failure.
        throw err;
      }

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsedId}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Soft-delete                                                         */
/* ------------------------------------------------------------------ */

export async function deleteCampaignAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_DELETE,
      entityType: "marketing_campaign",
      entityId: id,
    },
    async () => {
      const user = await requireMarketingPermission();
      const parsedId = uuidSchema.parse(id);

      const campaign = await loadCampaign(parsedId);
      if (campaign.isDeleted) throw new NotFoundError("campaign");
      if (campaign.status !== "draft" && campaign.status !== "cancelled") {
        throw new ConflictError(
          "Only draft or cancelled campaigns can be deleted.",
        );
      }

      await db
        .update(marketingCampaigns)
        .set({
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: user.id,
          updatedAt: new Date(),
          updatedById: user.id,
        })
        .where(eq(marketingCampaigns.id, parsedId));

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_DELETE,
        targetType: "marketing_campaign",
        targetId: parsedId,
        before: { name: campaign.name, status: campaign.status },
      });

      revalidatePath("/marketing/campaigns");
    },
  );
}

/* ------------------------------------------------------------------ */
/* Test send                                                           */
/* ------------------------------------------------------------------ */

export async function sendCampaignTestAction(input: {
  id: string;
  recipientEmail: string;
}): Promise<ActionResult<{ messageId: string }>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_TEST_SEND,
      entityType: "marketing_campaign",
      entityId: input.id,
    },
    async () => {
      const user = await requireMarketingPermission();
      if (!sendgridConfigured) {
        throw new ValidationError(
          "SendGrid is not configured for this environment.",
        );
      }
      const parsed = campaignTestSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first?.message ?? "Validation failed.",
        );
      }

      const limit = await rateLimit(
        { kind: "test_send", principal: user.id },
        env.RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR,
        60 * 60,
      );
      if (!limit.allowed) {
        throw new RateLimitError(
          "You've hit the test-send limit for the past hour. Try again later.",
        );
      }

      const campaign = await loadCampaign(parsed.data.id);
      if (campaign.isDeleted) throw new NotFoundError("campaign");

      const [tpl] = await db
        .select({
          subject: marketingTemplates.subject,
          html: marketingTemplates.renderedHtml,
        })
        .from(marketingTemplates)
        .where(
          and(
            eq(marketingTemplates.id, campaign.templateId),
            eq(marketingTemplates.isDeleted, false),
          ),
        )
        .limit(1);
      if (!tpl) throw new NotFoundError("template");

      const { messageId } = await sendTestEmail({
        recipientEmail: parsed.data.recipientEmail,
        subject: tpl.subject,
        html: tpl.html,
        fromName: campaign.fromName,
        actorUserId: user.id,
        featureRecordId: parsed.data.id,
      });

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_TEST_SEND,
        targetType: "marketing_campaign",
        targetId: parsed.data.id,
        after: {
          recipientEmail: parsed.data.recipientEmail,
          messageId,
        },
      });

      return { messageId };
    },
  );
}

/* ------------------------------------------------------------------ */
/* Helpers re-exported for the wizard's resume flow                    */
/* ------------------------------------------------------------------ */

export async function getCampaignRecipientPageAction(input: {
  id: string;
  page?: number;
  status?: string;
}): Promise<
  ActionResult<{
    rows: {
      id: string;
      email: string;
      status: string;
      firstOpenedAt: Date | null;
      firstClickedAt: Date | null;
      bounceReason: string | null;
    }[];
    total: number;
  }>
> {
  return withErrorBoundary(
    { action: "marketing.campaign.recipients_page" },
    async () => {
      const user = await requireMarketingPermission();
      void user;
      const id = uuidSchema.parse(input.id);
      const page = Math.max(1, Math.floor(input.page ?? 1));
      const pageSize = 50;
      const offset = (page - 1) * pageSize;

      const where = input.status
        ? and(
            eq(campaignRecipients.campaignId, id),
            eq(campaignRecipients.status, input.status as never),
          )
        : eq(campaignRecipients.campaignId, id);

      const rows = await db
        .select({
          id: campaignRecipients.id,
          email: campaignRecipients.email,
          status: campaignRecipients.status,
          firstOpenedAt: campaignRecipients.firstOpenedAt,
          firstClickedAt: campaignRecipients.firstClickedAt,
          bounceReason: campaignRecipients.bounceReason,
        })
        .from(campaignRecipients)
        .where(where)
        .limit(pageSize)
        .offset(offset);

      const totalRow = await db
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(where);

      return { rows, total: totalRow.length };
    },
  );
}
