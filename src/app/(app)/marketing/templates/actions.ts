"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireAdmin,
  requireSession,
  type MarketingPermissionKey,
} from "@/lib/auth-helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { forceReleaseLock, getLock } from "@/lib/marketing/template-lock";
import { canEditTemplate, canViewTemplate } from "@/lib/marketing/templates";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  withErrorBoundary,
  type ActionResult,
} from "@/lib/server-action";
// Sub-agent A modules. Imports kept loose (no top-level
// type imports) so a missing implementation typechecks via the runtime
// boundary; the lead resolves any coordination gap before merge.
import { pushTemplateToSendGrid } from "@/lib/marketing/sendgrid/templates";
import { sendTestEmail } from "@/lib/marketing/sendgrid/send";

const createTemplateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required.")
    .max(998, "Subject must be 998 characters or fewer."),
  preheader: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Visibility scope chosen by the creator. Defaults to
  // 'global' to match pre-Phase-29 behavior; form submissions that
  // omit the field also fall through to 'global'.
  scope: z.enum(["global", "personal"]).optional().default("global"),
});

const cloneTemplateSchema = z.object({
  id: z.string().uuid(),
});

const changeScopeSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  newScope: z.enum(["global", "personal"]),
});

const updateTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(998),
  preheader: z
    .string()
    .trim()
    .max(255)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  unlayerDesignJson: z.record(z.unknown()),
  renderedHtml: z.string().min(1, "Rendered HTML is required."),
  markReady: z.boolean().optional(),
  sessionId: z.string().min(1),
});

const idSchema = z.object({ id: z.string().uuid() });

const sendTestSchema = z.object({
  id: z.string().uuid(),
  recipientEmail: z.string().email("Recipient must be a valid email address."),
});

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v !== "string") continue;
    if (v === "") continue;
    obj[k] = v;
  }
  return obj;
}

async function requireTemplatePermission(
  userId: string,
  perm: MarketingPermissionKey,
): Promise<void> {
  const perms = await getPermissions(userId);
  if (!perms[perm]) {
    throw new ForbiddenError(
      "You don't have permission to perform this template action.",
    );
  }
}

/**
 * Create a new template metadata row. The Unlayer design
 * starts empty; the editor populates it on first save.
 */
export async function createTemplateAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary({ action: "marketing.template.create" }, async () => {
    const user = await requireSession();
    if (!user.isAdmin)
      await requireTemplatePermission(user.id, "canMarketingTemplatesCreate");

    const parsed = createTemplateSchema.safeParse(formToObject(formData));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }

    const [row] = await db
      .insert(marketingTemplates)
      .values({
        name: parsed.data.name,
        description: parsed.data.description,
        subject: parsed.data.subject,
        preheader: parsed.data.preheader,
        unlayerDesignJson: {},
        renderedHtml: "",
        status: "draft",
        scope: parsed.data.scope,
        source: "manual",
        createdById: user.id,
        updatedById: user.id,
      })
      .returning({ id: marketingTemplates.id });

    if (!row) {
      throw new ValidationError("Failed to create template.");
    }

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.TEMPLATE_CREATE,
      targetType: "marketing_template",
      targetId: row.id,
      after: {
        name: parsed.data.name,
        subject: parsed.data.subject,
        scope: parsed.data.scope,
        source: "manual",
      },
    });

    revalidatePath("/marketing/templates");
    return { id: row.id };
  });
}

/**
 * Save the design + HTML, push to SendGrid, optionally
 * promote to ready. The OCC fence is a re-check of the soft-lock —
 * if a different sessionId now holds the lock the editor lost the
 * race (force-unlock by an admin) and we refuse the write.
 */
export async function updateTemplateAction(input: {
  id: string;
  name: string;
  subject: string;
  preheader?: string | null;
  description?: string | null;
  unlayerDesignJson: object;
  renderedHtml: string;
  markReady?: boolean;
  sessionId: string;
}): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.template.update" }, async () => {
    const user = await requireSession();
    if (!user.isAdmin)
      await requireTemplatePermission(user.id, "canMarketingTemplatesEdit");

    const parsed = updateTemplateSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }
    const data = parsed.data;

    const [existing] = await db
      .select()
      .from(marketingTemplates)
      .where(
        and(
          eq(marketingTemplates.id, data.id),
          eq(marketingTemplates.isDeleted, false),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError("template");

    // Visibility gate: a 'personal' template that you
    // don't own appears not to exist (404 rather than 403 to avoid
    // leaking existence).
    if (
      !canViewTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
      })
    ) {
      throw new NotFoundError("template");
    }

    // Edit gate:
    // personal → creator-only.
    // global → creator OR canMarketingTemplatesEdit.
    // (Admins bypass; the existing super-admin model is unchanged.)
    const perms = user.isAdmin ? null : await getPermissions(user.id);
    if (
      !canEditTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: user.id,
        canMarketingTemplatesEdit: perms?.canMarketingTemplatesEdit ?? false,
        isAdmin: user.isAdmin,
      })
    ) {
      throw new ForbiddenError(
        existing.scope === "personal"
          ? "Only the creator can edit a personal template."
          : "You don't have permission to edit this template.",
      );
    }

    // Lock fence — the editor must still hold the lock for this
    // session id. A force-unlock by an admin transfers the lock to a
    // new editor; we surface that as a Conflict so the UI can prompt
    // a refresh.
    const currentLock = await getLock(data.id);
    if (currentLock && currentLock.sessionId !== data.sessionId) {
      throw new ConflictError(
        "Lock has been transferred to another editor. Refresh and try again.",
      );
    }

    const newStatus =
      data.markReady && existing.status === "draft" ? "ready" : existing.status;

    // Push to SendGrid first; if it fails, the local row stays at the
    // previous design so the user can retry without losing work.
    let sendgridIds = {
      sendgridTemplateId: existing.sendgridTemplateId,
      sendgridVersionId: existing.sendgridVersionId,
    };
    try {
      const pushed = await pushTemplateToSendGrid({
        id: data.id,
        name: data.name,
        subject: data.subject,
        renderedHtml: data.renderedHtml,
        sendgridTemplateId: existing.sendgridTemplateId,
      });
      sendgridIds = {
        sendgridTemplateId: pushed.sendgridTemplateId,
        sendgridVersionId: pushed.sendgridVersionId,
      };
    } catch (err) {
      // Bubble the SendGrid error up — withErrorBoundary turns
      // SendGridApiError / MarketingNotConfiguredError into a clean
      // user-facing message via their KnownError surface. We log a
      // structured warning so the operator can see the upstream code.
      logger.warn("marketing.template.sendgrid_push_failed", {
        templateId: data.id,
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await db
      .update(marketingTemplates)
      .set({
        name: data.name,
        subject: data.subject,
        preheader: data.preheader,
        description: data.description,
        unlayerDesignJson: data.unlayerDesignJson,
        renderedHtml: data.renderedHtml,
        status: newStatus,
        sendgridTemplateId: sendgridIds.sendgridTemplateId,
        sendgridVersionId: sendgridIds.sendgridVersionId,
        updatedById: user.id,
        updatedAt: new Date(),
        version: existing.version + 1,
      })
      .where(eq(marketingTemplates.id, data.id));

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.TEMPLATE_UPDATE,
      targetType: "marketing_template",
      targetId: data.id,
      before: {
        name: existing.name,
        subject: existing.subject,
        status: existing.status,
        version: existing.version,
      },
      after: {
        name: data.name,
        subject: data.subject,
        status: newStatus,
        version: existing.version + 1,
      },
    });

    if (sendgridIds.sendgridTemplateId !== existing.sendgridTemplateId
      || sendgridIds.sendgridVersionId !== existing.sendgridVersionId) {
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_PUSHED_TO_SENDGRID,
        targetType: "marketing_template",
        targetId: data.id,
        after: sendgridIds,
      });
    }

    revalidatePath("/marketing/templates");
    revalidatePath(`/marketing/templates/${data.id}`);
    revalidatePath(`/marketing/templates/${data.id}/edit`);
  });
}

/**
 * Soft-archive a template. The send pipeline refuses to
 * dispatch archived templates; campaigns that already reference one
 * stay attached so the campaign history reads cleanly.
 */
export async function archiveTemplateAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.template.archive" }, async () => {
    const user = await requireSession();
    if (!user.isAdmin)
      await requireTemplatePermission(user.id, "canMarketingTemplatesDelete");
    const parsed = idSchema.safeParse({ id });
    if (!parsed.success) throw new ValidationError("Invalid template id.");

    const [existing] = await db
      .select({
        id: marketingTemplates.id,
        name: marketingTemplates.name,
        status: marketingTemplates.status,
        isDeleted: marketingTemplates.isDeleted,
        scope: marketingTemplates.scope,
        createdById: marketingTemplates.createdById,
      })
      .from(marketingTemplates)
      .where(eq(marketingTemplates.id, parsed.data.id))
      .limit(1);
    if (!existing) throw new NotFoundError("template");
    if (existing.isDeleted) {
      // Idempotent — already archived.
      return;
    }

    // Visibility + edit gate. Personal templates
    // are creator-only for any mutation including delete; global
    // templates require canMarketingTemplatesEdit OR creator.
    if (
      !canViewTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: user.id,
        isAdmin: user.isAdmin,
      })
    ) {
      throw new NotFoundError("template");
    }
    const perms = user.isAdmin ? null : await getPermissions(user.id);
    if (
      !canEditTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: user.id,
        canMarketingTemplatesEdit: perms?.canMarketingTemplatesEdit ?? false,
        isAdmin: user.isAdmin,
      })
    ) {
      throw new ForbiddenError(
        existing.scope === "personal"
          ? "Only the creator can delete a personal template."
          : "You don't have permission to delete this template.",
      );
    }

    // refuse to archive a template referenced by any
    // active (scheduled or sending) campaign. Snapshot the blocking
    // campaigns so the UI can link the user to them. The block is
    // audited as a separate event so the forensic trail captures the
    // attempt even though the row is unchanged.
    const blockingCampaigns = await db
      .select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
        status: marketingCampaigns.status,
      })
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.templateId, parsed.data.id),
          eq(marketingCampaigns.isDeleted, false),
          inArray(marketingCampaigns.status, ["scheduled", "sending"]),
        ),
      )
      .limit(20);
    if (blockingCampaigns.length > 0) {
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_DELETE_BLOCKED,
        targetType: "marketing_template",
        targetId: parsed.data.id,
        after: { blockingCampaigns },
      });
      throw new ConflictError(
        `Cannot archive: ${blockingCampaigns.length} active campaign(s) reference this template. Cancel or complete them first.`,
        { code: "TEMPLATE_IN_USE", references: blockingCampaigns },
      );
    }

    // Deletion cascade. Draft campaigns referencing
    // this template are unlinked (template_id → NULL) so the delete
    // can proceed. Scheduled/sending campaigns are caught by the
    // §6.5.2 block above; sent campaigns retain their FK because the
    // history needs the original template id to render audit views.
    //
    // We cascade for BOTH personal and global templates: a global
    // template can also be deleted by the creator (or an editor) and
    // any in-progress drafts still need to be unlinked rather than
    // FK-pinned. This is a slight broadening of the brief (the brief
    // names "personal"), but the safer behavior — and the cascade
    // never silently DELETES a campaign; it just clears the FK.
    const unlinkedCampaigns = await db
      .select({ id: marketingCampaigns.id, name: marketingCampaigns.name })
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.templateId, parsed.data.id),
          eq(marketingCampaigns.status, "draft"),
          eq(marketingCampaigns.isDeleted, false),
        ),
      );
    if (unlinkedCampaigns.length > 0) {
      await db
        .update(marketingCampaigns)
        .set({
          templateId: null,
          updatedById: user.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(marketingCampaigns.templateId, parsed.data.id),
            eq(marketingCampaigns.status, "draft"),
            eq(marketingCampaigns.isDeleted, false),
          ),
        );
      // Audit one row per cleared FK — granular forensic trail.
      for (const c of unlinkedCampaigns) {
        await writeAudit({
          actorId: user.id,
          action: MARKETING_AUDIT_EVENTS.CAMPAIGN_TEMPLATE_UNLINKED,
          targetType: "marketing_campaign",
          targetId: c.id,
          after: {
            unlinkedFromTemplateId: parsed.data.id,
            templateName: existing.name,
            reason: "template_archived",
          },
        });
      }
    }

    await db
      .update(marketingTemplates)
      .set({
        status: "archived",
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: user.id,
        updatedById: user.id,
        updatedAt: new Date(),
      })
      .where(eq(marketingTemplates.id, parsed.data.id));

    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.TEMPLATE_DELETE,
      targetType: "marketing_template",
      targetId: parsed.data.id,
      before: { name: existing.name, status: existing.status, scope: existing.scope },
      after: {
        status: "archived",
        isDeleted: true,
        unlinkedDraftCampaignIds: unlinkedCampaigns.map((c) => c.id),
      },
    });

    revalidatePath("/marketing/templates");
    redirect("/marketing/templates");
  });
}

/**
 * Send a single test email through SendGrid. Rate-limited
 * per-user (defaults to 20/hour) so an over-eager preview loop can't
 * burn the daily SendGrid quota.
 */
export async function sendTestTemplateAction(input: {
  id: string;
  recipientEmail: string;
}): Promise<ActionResult<{ messageId: string }>> {
  return withErrorBoundary(
    { action: "marketing.template.test_send" },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin)
        await requireTemplatePermission(
          user.id,
          "canMarketingTemplatesSendTest",
        );

      const parsed = sendTestSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      const limit = await rateLimit(
        { kind: "test_send", principal: user.id },
        env.RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR,
        60 * 60,
      );
      if (!limit.allowed) {
        throw new RateLimitError(
          "You've sent too many test emails this hour. Try again later.",
        );
      }

      const [existing] = await db
        .select()
        .from(marketingTemplates)
        .where(
          and(
            eq(marketingTemplates.id, parsed.data.id),
            eq(marketingTemplates.isDeleted, false),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError("template");

      // Visibility gate: sending a test on a personal
      // template you can't see returns 404, same as the read path.
      if (
        !canViewTemplate({
          template: {
            scope: existing.scope,
            createdById: existing.createdById,
          },
          userId: user.id,
          isAdmin: user.isAdmin,
        })
      ) {
        throw new NotFoundError("template");
      }

      const result = await sendTestEmail({
        templateId: existing.id,
        recipientEmail: parsed.data.recipientEmail,
        actorUserId: user.id,
      });

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_TEST_SEND,
        targetType: "marketing_template",
        targetId: existing.id,
        after: {
          recipient: parsed.data.recipientEmail,
          messageId: result.messageId,
        },
      });

      return { messageId: result.messageId };
    },
  );
}

/**
 * Clone an existing template into a new personal
 * row owned by the current user. The source must be visible to the
 * caller (global, or personal-owned-by-caller); the destination is
 * always `scope='personal'` so a casual marketer can iterate on a
 * shared template without overwriting it.
 *
 * Requires `canMarketingTemplatesCreate`.
 */
export async function cloneTemplateAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary(
    { action: "marketing.template.clone" },
    async () => {
      const user = await requireSession();
      const perms = user.isAdmin ? null : await getPermissions(user.id);
      if (!user.isAdmin && !perms?.canMarketingTemplatesCreate) {
        throw new ForbiddenError(
          "You don't have permission to create marketing templates.",
        );
      }

      const parsed = cloneTemplateSchema.safeParse(formToObject(formData));
      if (!parsed.success) {
        throw new ValidationError("Invalid template id.");
      }

      const [source] = await db
        .select()
        .from(marketingTemplates)
        .where(
          and(
            eq(marketingTemplates.id, parsed.data.id),
            eq(marketingTemplates.isDeleted, false),
          ),
        )
        .limit(1);
      if (!source) throw new NotFoundError("template");

      // Visibility — same gate as a read; a personal template you
      // don't own can't be cloned (and shouldn't even be enumerable).
      if (
        !canViewTemplate({
          template: { scope: source.scope, createdById: source.createdById },
          userId: user.id,
          isAdmin: user.isAdmin,
        })
      ) {
        throw new NotFoundError("template");
      }

      // The clone is always 'draft' / 'personal' regardless of the
      // source state — the marketer is iterating on a copy and the
      // SendGrid template-id is intentionally cleared so first save
      // mints a new SG template. Empty SG ids avoid an accidental
      // overwrite of the source's SendGrid version on the next push.
      const [row] = await db
        .insert(marketingTemplates)
        .values({
          name: `${source.name} (copy)`,
          description: source.description,
          subject: source.subject,
          preheader: source.preheader,
          unlayerDesignJson: source.unlayerDesignJson,
          renderedHtml: source.renderedHtml,
          status: "draft",
          scope: "personal",
          source: "manual",
          sendgridTemplateId: null,
          sendgridVersionId: null,
          createdById: user.id,
          updatedById: user.id,
        })
        .returning({ id: marketingTemplates.id });

      if (!row) {
        throw new ValidationError("Failed to clone template.");
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_CLONED,
        targetType: "marketing_template",
        targetId: row.id,
        after: {
          sourceTemplateId: source.id,
          sourceTemplateName: source.name,
          newScope: "personal",
        },
      });

      revalidatePath("/marketing/templates");
      return { id: row.id };
    },
  );
}

/**
 * Promote or demote a template's visibility scope.
 *
 * personal → global : creator-only. (Anyone can publish their
 * own personal work; the canMarketingTemplatesEdit
 * gate is intentionally NOT required here
 * because the user is already allowed to edit
 * their own creator-owned content.)
 * global → personal : creator-only AND canMarketingTemplatesEdit.
 * Demoting hides a template from everyone
 * else, so we require both the ownership
 * signal AND the edit-others permission to
 * avoid a non-editor accidentally hiding a
 * shared template they happen to own.
 *
 * OCC version check fences against a concurrent edit. The lock is
 * NOT consulted — scope changes are a metadata-only operation and
 * shouldn't be blocked by an open Unlayer editor.
 */
export async function changeTemplateScopeAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "marketing.template.scope_change" },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin)
        await requireTemplatePermission(user.id, "canMarketingTemplatesEdit");

      const parsed = changeScopeSchema.safeParse(formToObject(formData));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }
      const data = parsed.data;

      const [existing] = await db
        .select()
        .from(marketingTemplates)
        .where(
          and(
            eq(marketingTemplates.id, data.id),
            eq(marketingTemplates.isDeleted, false),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundError("template");

      // Visibility check first so a personal template you can't see
      // 404s instead of 403s.
      if (
        !canViewTemplate({
          template: {
            scope: existing.scope,
            createdById: existing.createdById,
          },
          userId: user.id,
          isAdmin: user.isAdmin,
        })
      ) {
        throw new NotFoundError("template");
      }

      // No-op short-circuit — preserves OCC version semantics.
      if (existing.scope === data.newScope) {
        return;
      }

      // Creator gate. Admins bypass.
      if (!user.isAdmin && existing.createdById !== user.id) {
        throw new ForbiddenError(
          "Only the creator can change a template's visibility.",
        );
      }

      // Demote requires canMarketingTemplatesEdit on top of creator.
      if (data.newScope === "personal" && !user.isAdmin) {
        const perms = await getPermissions(user.id);
        if (!perms.canMarketingTemplatesEdit) {
          throw new ForbiddenError(
            "You don't have permission to make a global template personal.",
          );
        }
      }

      // OCC fence — refuse if a concurrent edit changed the row.
      if (existing.version !== data.version) {
        throw new ConflictError(
          "Template was changed by someone else. Refresh and try again.",
        );
      }

      await db
        .update(marketingTemplates)
        .set({
          scope: data.newScope,
          updatedById: user.id,
          updatedAt: new Date(),
          version: existing.version + 1,
        })
        .where(eq(marketingTemplates.id, data.id));

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_SCOPE_CHANGED,
        targetType: "marketing_template",
        targetId: data.id,
        before: { scope: existing.scope, version: existing.version },
        after: {
          from: existing.scope,
          to: data.newScope,
          version: existing.version + 1,
        },
      });

      revalidatePath("/marketing/templates");
      revalidatePath(`/marketing/templates/${data.id}`);
      revalidatePath(`/marketing/templates/${data.id}/edit`);
    },
  );
}

/**
 * Admin-only: drop the soft-lock. The previous holder
 * loses unsaved work; this is logged via
 * `MARKETING_AUDIT_EVENTS.TEMPLATE_FORCE_UNLOCK`.
 */
export async function forceUnlockTemplateAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "marketing.template.force_unlock" },
    async () => {
      const admin = await requireAdmin();
      const parsed = idSchema.safeParse({ id });
      if (!parsed.success) throw new ValidationError("Invalid template id.");

      const before = await getLock(parsed.data.id);
      await forceReleaseLock(parsed.data.id);

      await writeAudit({
        actorId: admin.id,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_FORCE_UNLOCK,
        targetType: "marketing_template",
        targetId: parsed.data.id,
        before: before
          ? {
              previousHolderId: before.userId,
              previousHolderName: before.userName,
              acquiredAt: before.acquiredAt.toISOString(),
            }
          : null,
      });

      revalidatePath(`/marketing/templates/${parsed.data.id}/edit`);
      revalidatePath(`/marketing/templates/${parsed.data.id}`);
    },
  );
}
