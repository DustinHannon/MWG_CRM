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
import { cleanupBlobsForUser, gatherBlobsForUser } from "@/lib/blob-cleanup";
import { logger } from "@/lib/logger";

/**
 * Pre-flight info shown in the delete-user modal.
 *
 * `leadCount` drives the disposition options:
 *  - 0 leads → simple "type DELETE" confirmation, no radio
 *  - ≥1 leads → reassign or cascade-delete radio
 *
 * `activityCount` is informational only — activities authored by the
 * deleted user always have user_id SET NULL via the FK; we surface that
 * "your activities will be preserved with author shown as 'Deleted user'".
 */
export interface DeleteUserPreflight {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    displayName: string;
    isBreakglass: boolean;
    isSelf: boolean;
    leadCount: number;
    activityCount: number;
  };
  /** Active non-breakglass users (excluding the target) — reassign options. */
  reassignTargets?: Array<{ id: string; displayName: string; email: string }>;
  /** Total admin count — used to enforce "can't delete the last admin". */
  adminCount?: number;
}

export async function getDeleteUserPreflight(
  userId: string,
): Promise<DeleteUserPreflight> {
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
  if (!target[0]) return { ok: false, error: "User not found." };

  const [counts, candidates, adminRows] = await Promise.all([
    db.execute<{ leads: number; activities: number } & Record<string, unknown>>(sql`
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
    ok: true,
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

export interface DeleteUserResult {
  ok: boolean;
  error?: string;
}

/**
 * Single transaction:
 * - reassign disposition: UPDATE leads SET owner_id = newOwner; DELETE user.
 *   Activities (user_id) get SET NULL via FK; permissions / saved_views /
 *   user_preferences / accounts / sessions go via CASCADE.
 * - delete_leads disposition: gather attachment blob pathnames first,
 *   then DELETE FROM leads (cascade hits activities + attachments),
 *   then DELETE user. Blob cleanup runs OUTSIDE the transaction so a
 *   network failure doesn't roll back the DB delete.
 */
export async function deleteUserAction(
  formData: FormData,
): Promise<DeleteUserResult> {
  const admin = await requireAdmin();
  const parsed = deleteSchema.safeParse({
    userId: formData.get("userId"),
    disposition: formData.get("disposition"),
    reassignTo: formData.get("reassignTo") || undefined,
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "Invalid input.",
    };
  }
  const { userId, disposition, reassignTo, confirm } = parsed.data;

  // Type-to-confirm gate, different per disposition.
  const expected =
    disposition === "delete_leads" ? "DELETE LEADS" : "DELETE";
  if (confirm !== expected) {
    return { ok: false, error: `Type "${expected}" exactly to confirm.` };
  }

  if (admin.id === userId) {
    return { ok: false, error: "You cannot delete your own account." };
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
  if (!target[0]) return { ok: false, error: "User not found." };
  if (target[0].isBreakglass) {
    return { ok: false, error: "Cannot delete the breakglass account." };
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
      return {
        ok: false,
        error:
          "Cannot delete the last remaining active admin. Promote another user first.",
      };
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

  try {
    await db.transaction(async (tx) => {
      if (disposition === "reassign") {
        if (!reassignTo) throw new Error("reassignTo missing");
        const newOwner = await tx
          .select({
            id: users.id,
            isActive: users.isActive,
            isBreakglass: users.isBreakglass,
          })
          .from(users)
          .where(eq(users.id, reassignTo))
          .limit(1);
        if (!newOwner[0] || !newOwner[0].isActive || newOwner[0].isBreakglass) {
          throw new Error("Reassign target must be an active non-breakglass user.");
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
        // attachments are removed via FK cascade from activities; but
        // we issue an explicit delete on activities first so we get a
        // count if needed (Drizzle returns void, but Postgres still
        // executes ahead of the cascade).
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
  } catch (err) {
    logger.error("admin.delete_user_txn_failed", {
      targetUserId: userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Delete failed.",
    };
  }

  // Blob cleanup — outside the transaction. Failures here log but do not
  // surface as an error to the admin (the DB record is the truth).
  if (blobPaths.length > 0) {
    void cleanupBlobsForUser(userId).catch((err) =>
      logger.warn("admin.blob_cleanup_after_user_delete_failed", {
        targetUserId: userId,
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
}
