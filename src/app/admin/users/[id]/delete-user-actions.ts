"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql, and, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  deleteBlobsByPathnames,
  gatherBlobsForUser,
} from "@/lib/blob-cleanup";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Pre-flight info shown in the delete-user modal.
 *
 * `leadCount` drives the disposition options:
 * 0 leads → simple "type DELETE" confirmation, no radio
 * ≥1 leads → reassign or cascade-delete radio
 */
export interface DeleteUserPreflightData {
  user: {
    id: string;
    displayName: string;
    isBreakglass: boolean;
    isSelf: boolean;
    leadCount: number;
    activityCount: number;
  };
  /** Active non-breakglass users (excluding the target) — reassign options. */
  reassignTargets: Array<{ id: string; displayName: string; email: string }>;
  /** Total admin count — used to enforce "can't delete the last admin". */
  adminCount: number;
}

export async function getDeleteUserPreflight(
  userId: string,
): Promise<ActionResult<DeleteUserPreflightData>> {
  return withErrorBoundary(
    {
      action: "user.delete_preflight",
      entityType: "user",
      entityId: userId,
    },
    async (): Promise<DeleteUserPreflightData> => {
      const admin = await requireAdmin();

      const target = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          isAdmin: users.isAdmin,
          isBreakglass: users.isBreakglass,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target[0]) throw new NotFoundError("user");

      const [counts, candidates, adminRows] = await Promise.all([
        db.execute<
          { leads: number; activities: number } & Record<string, unknown>
        >(sql`
          SELECT
            (SELECT count(*)::int FROM ${leads} WHERE owner_id = ${userId}) AS leads,
            (SELECT count(*)::int FROM ${activities} WHERE user_id = ${userId}) AS activities
        `),
        db
          .select({
            id: users.id,
            displayName: users.displayName,
            email: users.email,
          })
          .from(users)
          .where(
            and(
              eq(users.isActive, true),
              eq(users.isBreakglass, false),
              ne(users.id, userId),
            ),
          ),
        db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.isAdmin, true), eq(users.isActive, true))),
      ]);

      return {
        user: {
          id: target[0].id,
          displayName: target[0].displayName,
          isBreakglass: target[0].isBreakglass,
          isSelf: admin.id === target[0].id,
          leadCount: counts[0]?.leads ?? 0,
          activityCount: counts[0]?.activities ?? 0,
        },
        reassignTargets: candidates,
        adminCount: adminRows.length,
      };
    },
  );
}

const deleteSchema = z
  .object({
    userId: z.string().uuid(),
    disposition: z.enum(["reassign", "delete_leads"]),
    /** required when disposition='reassign' */
    reassignTo: z.string().uuid().optional(),
    confirm: z.string(),
  })
  .refine(
    (d) => d.disposition !== "reassign" || Boolean(d.reassignTo),
    { message: "Pick a user to reassign to.", path: ["reassignTo"] },
  );

/**
 * Single transaction:
 * reassign disposition: UPDATE leads SET owner_id = newOwner; DELETE user.
 * Activities (user_id) get SET NULL via FK; permissions / saved_views /
 * user_preferences / accounts / sessions go via CASCADE.
 * delete_leads disposition: gather attachment blob pathnames first,
 * then DELETE FROM leads (cascade hits activities + attachments),
 * then DELETE user. Blob cleanup runs OUTSIDE the transaction so a
 * network failure doesn't roll back the DB delete.
 */
export async function deleteUserAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "user.delete" }, async () => {
    const admin = await requireAdmin();
    const parsed = deleteSchema.parse({
      userId: formData.get("userId"),
      disposition: formData.get("disposition"),
      reassignTo: formData.get("reassignTo") || undefined,
      confirm: formData.get("confirm"),
    });
    const { userId, disposition, reassignTo, confirm } = parsed;

    // Type-to-confirm gate, different per disposition.
    const expected = disposition === "delete_leads" ? "DELETE LEADS" : "DELETE";
    if (confirm !== expected) {
      throw new ValidationError(`Type "${expected}" exactly to confirm.`);
    }

    if (admin.id === userId) {
      throw new ForbiddenError("You cannot delete your own account.");
    }

    const target = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        isBreakglass: users.isBreakglass,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target[0]) throw new NotFoundError("user");
    if (target[0].isBreakglass) {
      throw new ForbiddenError("Cannot delete the breakglass account.");
    }

    // Last-admin guard.
    if (target[0].isAdmin) {
      const otherAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.isAdmin, true),
            eq(users.isActive, true),
            ne(users.id, userId),
          ),
        );
      if (otherAdmins.length === 0) {
        throw new ConflictError(
          "Cannot delete the last remaining active admin. Promote another user first.",
        );
      }
    }

    let blobPaths: string[] = [];
    if (disposition === "delete_leads") {
      blobPaths = await gatherBlobsForUser(userId);
    }

    const beforeSnapshot = {
      id: target[0].id,
      displayName: target[0].displayName,
      isAdmin: target[0].isAdmin,
    };

    await db.transaction(async (tx) => {
      if (disposition === "reassign") {
        if (!reassignTo) throw new ValidationError("reassignTo missing");
        const newOwner = await tx
          .select({
            id: users.id,
            isActive: users.isActive,
            isBreakglass: users.isBreakglass,
          })
          .from(users)
          .where(eq(users.id, reassignTo))
          .limit(1);
        if (
          !newOwner[0] ||
          !newOwner[0].isActive ||
          newOwner[0].isBreakglass
        ) {
          throw new ValidationError(
            "Reassign target must be an active non-breakglass user.",
          );
        }
        await tx
          .update(leads)
          .set({ ownerId: reassignTo, updatedAt: sql`now()` })
          .where(eq(leads.ownerId, userId));
      } else {
        // disposition === 'delete_leads' — explicit DELETE. Cascade
        // takes activities + attachments; we already gathered the blob
        // paths above, deletion of the actual blob objects happens
        // post-transaction.
        await tx
          .delete(attachments)
          .where(
            sql`activity_id IN (SELECT id FROM ${activities} WHERE lead_id IN (SELECT id FROM ${leads} WHERE owner_id = ${userId}))`,
          );
        await tx
          .delete(activities)
          .where(
            sql`lead_id IN (SELECT id FROM ${leads} WHERE owner_id = ${userId})`,
          );
        await tx.delete(leads).where(eq(leads.ownerId, userId));
      }

      // Finally, delete the user. Cascades wipe permissions, saved_views,
      // user_preferences, accounts, sessions. Activities authored by this
      // user have user_id set null automatically.
      await tx.delete(users).where(eq(users.id, userId));
    });

    // Blob cleanup — outside the transaction. Failures here log but do not
    // surface as an error to the admin (the DB record is the truth). Use
    // the pre-gathered paths from before the transaction; re-gathering
    // after delete returns empty (the join through leads.ownerId no
    // longer matches) and blobs would leak.
    if (blobPaths.length > 0) {
      void deleteBlobsByPathnames(blobPaths).catch((err) =>
        logger.warn("admin.blob_cleanup_after_user_delete_failed", {
          targetUserId: userId,
          blobCount: blobPaths.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    await writeAudit({
      actorId: admin.id,
      action: "user.delete",
      targetType: "user",
      targetId: userId,
      before: beforeSnapshot,
      after: {
        disposition,
        reassignTo: reassignTo ?? null,
        blobsScheduledForCleanup: blobPaths.length,
      },
    });

    revalidatePath("/admin/users");
    redirect("/admin/users");
  });
}
