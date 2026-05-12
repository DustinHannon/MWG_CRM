"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clickdimensionsMigrations } from "@/db/schema/clickdimensions-migrations";
import { permissions } from "@/db/schema/users";
import { requireSession } from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";

/**
 * Phase 29 §7 — Worklist actions for the ClickDimensions migrations
 * admin surface.
 *
 * Permission gate: requires admin OR `canMarketingMigrationsRun`.
 */

async function requireMigrationsAccess(): Promise<{ userId: string }> {
  const user = await requireSession();
  if (user.isAdmin) return { userId: user.id };
  const perm = await db
    .select({
      canMarketingMigrationsRun: permissions.canMarketingMigrationsRun,
    })
    .from(permissions)
    .where(eq(permissions.userId, user.id))
    .limit(1);
  if (!perm[0]?.canMarketingMigrationsRun) {
    throw new ForbiddenError(
      "You don't have permission to run migrations.",
    );
  }
  return { userId: user.id };
}

const IdSchema = z.object({ id: z.string().uuid() });
const IdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

/** Re-extract a single row — set status='pending' so the next run
 * picks it up. Increments attempts is left to the next extraction
 * POST. Audits as `fallback_manual` is incorrect; this is a "flag for
 * re-run" — we audit it as `failed` reset with after.reason. */
export async function flagForReextractionAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "marketing.migration.reextract" },
    async () => {
      const { userId } = await requireMigrationsAccess();
      const parsed = IdSchema.safeParse({ id: formData.get("id") });
      if (!parsed.success) {
        throw new ValidationError("Invalid id.");
      }
      const rows = await db
        .select()
        .from(clickdimensionsMigrations)
        .where(eq(clickdimensionsMigrations.id, parsed.data.id))
        .limit(1);
      if (!rows[0]) throw new NotFoundError("Migration row not found.");
      await db
        .update(clickdimensionsMigrations)
        .set({
          status: "pending",
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(eq(clickdimensionsMigrations.id, parsed.data.id));
      await writeAudit({
        actorId: userId,
        action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_FALLBACK_MANUAL,
        targetType: "clickdimensions_migration",
        targetId: parsed.data.id,
        after: { reason: "flag_for_reextract" },
      });
      revalidatePath("/admin/migrations/clickdimensions");
    },
  );
}

/** Mark a single row as skipped — admin chose manual fallback. */
export async function skipMigrationAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "marketing.migration.skip" },
    async () => {
      const { userId } = await requireMigrationsAccess();
      const parsed = IdSchema.safeParse({ id: formData.get("id") });
      if (!parsed.success) {
        throw new ValidationError("Invalid id.");
      }
      const rows = await db
        .select()
        .from(clickdimensionsMigrations)
        .where(eq(clickdimensionsMigrations.id, parsed.data.id))
        .limit(1);
      if (!rows[0]) throw new NotFoundError("Migration row not found.");
      await db
        .update(clickdimensionsMigrations)
        .set({
          status: "skipped",
          updatedAt: new Date(),
        })
        .where(eq(clickdimensionsMigrations.id, parsed.data.id));
      await writeAudit({
        actorId: userId,
        action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_FALLBACK_MANUAL,
        targetType: "clickdimensions_migration",
        targetId: parsed.data.id,
        after: { reason: "manual_skip" },
      });
      revalidatePath("/admin/migrations/clickdimensions");
    },
  );
}

/** Bulk: flag all selected rows for re-extraction. */
export async function bulkFlagForReextractionAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "marketing.migration.reextract_bulk" },
    async () => {
      const { userId } = await requireMigrationsAccess();
      const rawIds = formData.getAll("ids").map(String);
      const parsed = IdsSchema.safeParse({ ids: rawIds });
      if (!parsed.success) {
        throw new ValidationError("Invalid id list.");
      }
      await db
        .update(clickdimensionsMigrations)
        .set({
          status: "pending",
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(inArray(clickdimensionsMigrations.id, parsed.data.ids));
      for (const id of parsed.data.ids) {
        await writeAudit({
          actorId: userId,
          action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_FALLBACK_MANUAL,
          targetType: "clickdimensions_migration",
          targetId: id,
          after: { reason: "bulk_flag_for_reextract" },
        });
      }
      revalidatePath("/admin/migrations/clickdimensions");
    },
  );
}

/** Bulk: mark all selected rows as skipped. */
export async function bulkSkipAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "marketing.migration.skip_bulk" },
    async () => {
      const { userId } = await requireMigrationsAccess();
      const rawIds = formData.getAll("ids").map(String);
      const parsed = IdsSchema.safeParse({ ids: rawIds });
      if (!parsed.success) {
        throw new ValidationError("Invalid id list.");
      }
      await db
        .update(clickdimensionsMigrations)
        .set({
          status: "skipped",
          updatedAt: new Date(),
        })
        .where(inArray(clickdimensionsMigrations.id, parsed.data.ids));
      for (const id of parsed.data.ids) {
        await writeAudit({
          actorId: userId,
          action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_FALLBACK_MANUAL,
          targetType: "clickdimensions_migration",
          targetId: id,
          after: { reason: "bulk_manual_skip" },
        });
      }
      revalidatePath("/admin/migrations/clickdimensions");
    },
  );
}
