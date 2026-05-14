"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireSession,
  type MarketingPermissionKey,
} from "@/lib/auth-helpers";
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
import { sendTestEmail } from "@/lib/marketing/sendgrid/send";
import { resolveListRecipients } from "@/lib/marketing/lists/resolution";

/**
 * Campaign composer + lifecycle actions.
 *
 * Lifecycle gates are enforced both here and at the API layer; either
 * surface (server action call from the wizard, or REST PUT/POST) hits
 * the same state machine. Audit events use the canonical names from
 * `MARKETING_AUDIT_EVENTS`.
 *
 * State machine:
 * draft → scheduled (scheduleCampaignAction)
 * draft → scheduled (sendCampaignNowAction; scheduled_for=now())
 * draft → cancelled (cancelCampaignAction) // optional convenience
 * draft → deleted (deleteCampaignAction)
 * scheduled → scheduled (sendCampaignNowAction; resets scheduled_for=now())
 * scheduled → cancelled (cancelCampaignAction)
 * scheduled → sending (handled by marketing-process-scheduled-campaigns cron)
 * sending → sent (handled by sendCampaign; not via action)
 * sending → failed (handled by sendCampaign; not via action)
 * cancelled → deleted (deleteCampaignAction)
 */

/* ------------------------------------------------------------------ */
/* Validation schemas */
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
  // OCC on draft edits. The campaign-edit UI passes the
  // version it loaded; the UPDATE refuses to write if another writer
  // bumped it. Optional only for programmatic API callers where the
  // status='draft' TOCTOU close remains sufficient.
  expectedVersion: z.number().int().nonnegative().optional(),
});

const campaignScheduleSchema = z.object({
  id: uuidSchema,
  scheduledFor: z
    .union([z.string(), z.date()])
    .transform((v) => (v instanceof Date ? v : new Date(v))),
  // optional `expectedVersion` enables OCC. Callers
  // that loaded the campaign before submitting can pass the version
  // they saw; the UPDATE refuses to write if another writer bumped
  // it in the meantime. Optional so existing callers don't break;
  // when omitted the action falls back to the prior status='draft'
  // TOCTOU close (which is sufficient for single-writer flows).
  expectedVersion: z.number().int().nonnegative().optional(),
});

const campaignTestSchema = z.object({
  id: uuidSchema,
  recipientEmail: z.string().email().max(254),
});

/* ------------------------------------------------------------------ */
/* Permission helper */
/* ------------------------------------------------------------------ */

async function requireCampaignPermission(perm: MarketingPermissionKey) {
  const user = await requireSession();
  if (user.isAdmin) return user;
  const perms = await getPermissions(user.id);
  if (!perms[perm]) {
    throw new ForbiddenError(
      "You don't have permission to perform this campaign action.",
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
/* Create draft */
/* ------------------------------------------------------------------ */

export async function createCampaignDraftAction(input: {
  templateId?: string;
  listId?: string;
  name?: string;
}): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary(
    { action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CREATE },
    async () => {
      const user = await requireCampaignPermission("canMarketingCampaignsCreate");
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
/* Update draft */
/* ------------------------------------------------------------------ */

export async function updateCampaignDraftAction(input: {
  id: string;
  name?: string;
  templateId?: string;
  listId?: string;
  fromEmail?: string;
  fromName?: string;
  replyToEmail?: string;
  /** OCC: optional version loaded by the caller. */
  expectedVersion?: number;
}): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_UPDATE,
      entityType: "marketing_campaign",
      entityId: input.id,
    },
    async () => {
      const user = await requireCampaignPermission("canMarketingCampaignsEdit");
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
      // OCC: when caller passes `expectedVersion`, the
      // UPDATE atomically requires `version = expectedVersion` AND bumps
      // it. 0 rows affected ⇒ another writer beat us → ConflictError.
      const whereClauses = [
        eq(marketingCampaigns.id, parsed.data.id),
        eq(marketingCampaigns.status, "draft"),
        eq(marketingCampaigns.isDeleted, false),
      ];
      if (parsed.data.expectedVersion !== undefined) {
        whereClauses.push(
          eq(marketingCampaigns.version, parsed.data.expectedVersion),
        );
      }
      const updated = await db
        .update(marketingCampaigns)
        .set({
          ...patch,
          version: sql`${marketingCampaigns.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(...whereClauses))
        .returning({ id: marketingCampaigns.id });
      if (updated.length === 0) {
        if (parsed.data.expectedVersion !== undefined) {
          throw new ConflictError(
            "Another user has updated this campaign. Reload to see the latest changes.",
          );
        }
        throw new ConflictError(
          "Only draft campaigns can be edited. Cancel the campaign to make changes.",
        );
      }

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
/* Schedule */
/* ------------------------------------------------------------------ */

export async function scheduleCampaignAction(input: {
  id: string;
  scheduledFor: Date;
  expectedVersion?: number;
}): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SCHEDULE,
      entityType: "marketing_campaign",
      entityId: input.id,
    },
    async () => {
      const user = await requireCampaignPermission("canMarketingCampaignsSchedule");
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

      // OCC enforcement. When the caller supplied
      // `expectedVersion`, the UPDATE atomically:
      // matches the current version against the caller's snapshot,
      // bumps version by 1 on success.
      // If no row updated, the campaign was modified by another writer
      // in the meantime; surface as ConflictError so the UI can show
      // the standard "someone else changed this" recovery flow.
      // The status='draft' clause stays as a defense-in-depth guard
      // (it also catches the cron-claimed-scheduled race even without
      // expectedVersion).
      const whereClauses = [
        eq(marketingCampaigns.id, parsed.data.id),
        eq(marketingCampaigns.status, "draft"),
        eq(marketingCampaigns.isDeleted, false),
      ];
      if (parsed.data.expectedVersion !== undefined) {
        whereClauses.push(
          eq(marketingCampaigns.version, parsed.data.expectedVersion),
        );
      }

      // Pre-compute the recipient count so the campaign list / detail
      // pages and the post-send `totalFiltered` audit math have real
      // numbers to display. Resolution runs the suppression-filter
      // join so the stamped value matches what would actually be sent
      // at this moment. The cron pickup re-resolves at send time —
      // late-arriving suppressions reduce the actual send count
      // without rewriting this stamp (the schedule snapshot is a
      // forecast, not a guarantee).
      let stampedTotalRecipients = 0;
      try {
        const resolved = await resolveListRecipients(campaign.listId);
        stampedTotalRecipients = resolved.recipients.length;
      } catch (err) {
        logger.warn("marketing.campaign.schedule_resolve_failed", {
          campaignId: parsed.data.id,
          listId: campaign.listId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        // Resolution failure here is non-fatal — the schedule UPDATE
        // can still proceed with totalRecipients=0 (the default).
        // sendCampaign's resolve call will surface the real error
        // at send time.
      }

      const updated = await db
        .update(marketingCampaigns)
        .set({
          status: "scheduled",
          scheduledFor: parsed.data.scheduledFor,
          totalRecipients: stampedTotalRecipients,
          updatedAt: new Date(),
          updatedById: user.id,
          version: sql`${marketingCampaigns.version} + 1`,
        })
        .where(and(...whereClauses))
        .returning({ id: marketingCampaigns.id });

      if (updated.length === 0) {
        // Either the campaign was already scheduled/sent (status guard
        // missed) or the version expectation failed. Both are
        // conflict-class outcomes.
        throw new ConflictError(
          "This campaign was modified by someone else. Refresh and try again.",
          { code: "CONCURRENCY_CONFLICT" },
        );
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SCHEDULE,
        targetType: "marketing_campaign",
        targetId: parsed.data.id,
        before: {
          status: campaign.status,
          scheduledFor: campaign.scheduledFor,
          version: campaign.version,
        },
        after: {
          status: "scheduled",
          scheduledFor: parsed.data.scheduledFor.toISOString(),
          version: campaign.version + 1,
        },
      });

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsed.data.id}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Cancel */
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
      const user = await requireCampaignPermission("canMarketingCampaignsCancel");
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
/* Send now */
/* ------------------------------------------------------------------ */

export async function sendCampaignNowAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    {
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_ENQUEUED,
      entityType: "marketing_campaign",
      entityId: id,
    },
    async () => {
      const user = await requireCampaignPermission("canMarketingCampaignsSendNow");
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

      // Pre-compute totalRecipients before the status flip so the
      // detail page and audit math reflect reality. Mirrors the
      // schedule-action behavior; see scheduleCampaignAction's
      // comment for the forecast-vs-guarantee semantics.
      let stampedTotalRecipients = campaign.totalRecipients;
      try {
        const resolved = await resolveListRecipients(campaign.listId);
        stampedTotalRecipients = resolved.recipients.length;
      } catch (err) {
        logger.warn("marketing.campaign.send_now_resolve_failed", {
          campaignId: parsedId,
          listId: campaign.listId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      // Atomic enqueue — status guard in the WHERE clause closes the
      // TOCTOU race between the loadCampaign() snapshot above and the
      // UPDATE below. The cron picker
      // (/api/cron/marketing-process-scheduled-campaigns) uses the
      // same conditional-UPDATE pattern transitioning scheduled ->
      // sending, so a duplicate click that arrives after the cron has
      // already claimed the row finds status=sending and throws
      // ConflictError cleanly.
      //
      // This action is the UI's "Send Now" path. It mirrors the
      // public API route POST /api/v1/marketing/campaigns/{id}/send-now
      // (shipped in 013c286) — both enqueue rather than sync-send so
      // the request returns immediately and the user can navigate
      // away. The cron picks up within ~60s and runs the SendGrid
      // batch; the campaign card's realtime subscription flips the
      // status as state advances.
      const result = await db
        .update(marketingCampaigns)
        .set({
          status: "scheduled",
          scheduledFor: sql`now()`,
          totalRecipients: stampedTotalRecipients,
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
        .returning({
          id: marketingCampaigns.id,
          scheduledFor: marketingCampaigns.scheduledFor,
        });

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
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_ENQUEUED,
        targetType: "marketing_campaign",
        targetId: parsedId,
        before: { status: campaign.status },
        after: {
          status: "scheduled",
          scheduledFor: result[0].scheduledFor,
          source: "ui",
        },
      });

      revalidatePath("/marketing/campaigns");
      revalidatePath(`/marketing/campaigns/${parsedId}`);
    },
  );
}

/* ------------------------------------------------------------------ */
/* Soft-delete */
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
      const user = await requireCampaignPermission("canMarketingCampaignsDelete");
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
/* Test send */
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
      const user = await requireCampaignPermission("canMarketingCampaignsSendTest");
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

      // campaign.templateId is now nullable (a draft
      // can be left dangling after a personal-template delete). A
      // test send against a dangling campaign has nothing to render;
      // surface a Validation error so the wizard prompts the user to
      // pick a new template before retrying.
      if (!campaign.templateId) {
        throw new ValidationError(
          "This campaign has no template. Pick one before sending a test.",
        );
      }

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
/* Helpers re-exported for the wizard's resume flow */
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
      const user = await requireCampaignPermission("canMarketingCampaignsView");
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
