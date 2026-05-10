"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireAdmin,
  requireSession,
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
import { rateLimit } from "@/lib/security/rate-limit";
import {
  withErrorBoundary,
  type ActionResult,
} from "@/lib/server-action";
// Phase 21 — Sub-agent A modules. Imports kept loose (no top-level
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

async function requireMarketingPermission(userId: string): Promise<void> {
  const perms = await getPermissions(userId);
  if (!perms.canManageMarketing) {
    throw new ForbiddenError(
      "You don't have permission to manage marketing templates.",
    );
  }
}

/**
 * Phase 21 — Create a new template metadata row. The Unlayer design
 * starts empty; the editor populates it on first save.
 */
export async function createTemplateAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return withErrorBoundary({ action: "marketing.template.create" }, async () => {
    const user = await requireSession();
    if (!user.isAdmin) await requireMarketingPermission(user.id);

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
      },
    });

    revalidatePath("/marketing/templates");
    return { id: row.id };
  });
}

/**
 * Phase 21 — Save the design + HTML, push to SendGrid, optionally
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
    if (!user.isAdmin) await requireMarketingPermission(user.id);

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
 * Phase 21 — Soft-archive a template. The send pipeline refuses to
 * dispatch archived templates; campaigns that already reference one
 * stay attached so the campaign history reads cleanly.
 */
export async function archiveTemplateAction(
  id: string,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "marketing.template.archive" }, async () => {
    const user = await requireSession();
    if (!user.isAdmin) await requireMarketingPermission(user.id);
    const parsed = idSchema.safeParse({ id });
    if (!parsed.success) throw new ValidationError("Invalid template id.");

    const [existing] = await db
      .select({
        id: marketingTemplates.id,
        name: marketingTemplates.name,
        status: marketingTemplates.status,
        isDeleted: marketingTemplates.isDeleted,
      })
      .from(marketingTemplates)
      .where(eq(marketingTemplates.id, parsed.data.id))
      .limit(1);
    if (!existing) throw new NotFoundError("template");
    if (existing.isDeleted) {
      // Idempotent — already archived.
      return;
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
      before: { name: existing.name, status: existing.status },
      after: { status: "archived", isDeleted: true },
    });

    revalidatePath("/marketing/templates");
    redirect("/marketing/templates");
  });
}

/**
 * Phase 21 — Send a single test email through SendGrid. Rate-limited
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
      if (!user.isAdmin) await requireMarketingPermission(user.id);

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
 * Phase 21 — Admin-only: drop the soft-lock. The previous holder
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
