"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql, and, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { apiKeys } from "@/db/schema/api-keys";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { importRuns } from "@/db/schema/d365-imports";
import { emailSendLog } from "@/db/schema/email-send-log";
import { leads } from "@/db/schema/leads";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingLists } from "@/db/schema/marketing-lists";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { gatherBlobsForUser } from "@/lib/blob-cleanup";
import { SYSTEM_SENTINEL_USER_ID } from "@/lib/constants/system-users";
import { enqueueJob } from "@/lib/jobs/queue";
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

      if (userId === SYSTEM_SENTINEL_USER_ID) {
        throw new ForbiddenError(
          "The system account cannot be deleted. It owns system-attributed audit, email, and job history.",
        );
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
              ne(users.id, SYSTEM_SENTINEL_USER_ID),
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
 * Single transaction. The full set of FK relationships pointing at
 * `users.id` is handled explicitly here because the database does NOT
 * cascade-delete everything — six authorship columns are NOT-NULL with
 * ON DELETE RESTRICT and would abort the whole delete with a foreign-key
 * violation if left alone.
 *
 * Handling per relation:
 *   - Owned business records (leads owner_id is RESTRICT; crm_accounts /
 *     contacts / opportunities owner_id and tasks assigned_to_id are
 *     SET NULL) are reassigned, never orphaned:
 *       reassign     → moved to the admin-chosen successor.
 *       delete_leads  → leads (+ their activities + attachments) are
 *                        hard-deleted; the non-lead business records and
 *                        assigned tasks are reassigned to the system
 *                        account (they are not leads, so deleting them
 *                        under the "delete leads" choice would be wrong;
 *                        a system owner keeps them admin-visible).
 *   - NOT-NULL RESTRICT authorship columns (marketing_lists /
 *     marketing_campaigns / marketing_templates created_by_id,
 *     api_keys created_by_id, email_send_log from_user_id,
 *     import_runs created_by_id) are reassigned to the system sentinel
 *     user so the historical/operational rows survive the delete with a
 *     clearly system-owned attribution.
 *   - SET NULL provenance stamps (created_by_id / updated_by_id /
 *     deleted_by_id / activities.user_id / audit_log.actor_id, etc.) are
 *     left to the database FK action. Audit history is forensic-grade and
 *     is never destroyed — only the actor FK nulls; the row's
 *     actor_email_snapshot preserves identity.
 *   - CASCADE children (Auth.js accounts + sessions, permissions,
 *     user_preferences, saved_views, saved_reports,
 *     saved_search_subscriptions, recent_views, notifications,
 *     marketing_template_locks) are removed by the database.
 *
 * Blob cleanup is enqueued OUTSIDE the transaction so a queue hiccup
 * cannot roll back the committed DB delete.
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

    if (userId === SYSTEM_SENTINEL_USER_ID) {
      throw new ForbiddenError(
        "The system account cannot be deleted. It owns system-attributed audit, email, and job history.",
      );
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

    // Counts of rows whose authorship moved to the system account, for
    // the forensic audit record.
    const systemReassignedCounts: Record<string, number> = {};

    await db.transaction(async (tx) => {
      // Records whose owner can be a non-lead business record (accounts,
      // contacts, opportunities) or an assigned task get a successor:
      // the admin-chosen user on `reassign`, otherwise the system
      // account. They are never left owner-less / unassigned.
      let businessSuccessor: string;

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
          newOwner[0].isBreakglass ||
          newOwner[0].id === userId ||
          newOwner[0].id === SYSTEM_SENTINEL_USER_ID
        ) {
          throw new ValidationError(
            "Reassign target must be an active non-breakglass user other than the user being deleted.",
          );
        }
        businessSuccessor = reassignTo;
        await tx
          .update(leads)
          .set({ ownerId: reassignTo, updatedAt: sql`now()` })
          .where(eq(leads.ownerId, userId));
      } else {
        // disposition === 'delete_leads' — explicit DELETE of the user's
        // leads. Cascade takes activities + attachments; blob paths were
        // gathered above, blob-object deletion happens post-transaction.
        businessSuccessor = SYSTEM_SENTINEL_USER_ID;
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

      // Reassign non-lead owned business records + assigned tasks so the
      // database SET NULL does not silently orphan them (an owner-less
      // account / unassigned open task is lost work, invisible in
      // owner-scoped views).
      const acct = await tx
        .update(crmAccounts)
        .set({ ownerId: businessSuccessor, updatedAt: sql`now()` })
        .where(eq(crmAccounts.ownerId, userId))
        .returning({ id: crmAccounts.id });
      const cont = await tx
        .update(contacts)
        .set({ ownerId: businessSuccessor, updatedAt: sql`now()` })
        .where(eq(contacts.ownerId, userId))
        .returning({ id: contacts.id });
      const opp = await tx
        .update(opportunities)
        .set({ ownerId: businessSuccessor, updatedAt: sql`now()` })
        .where(eq(opportunities.ownerId, userId))
        .returning({ id: opportunities.id });
      const tsk = await tx
        .update(tasks)
        .set({ assignedToId: businessSuccessor, updatedAt: sql`now()` })
        .where(eq(tasks.assignedToId, userId))
        .returning({ id: tasks.id });

      // NOT-NULL ON DELETE RESTRICT authorship columns. These would abort
      // the whole delete with an FK violation if left alone, so the
      // historical/operational rows are re-attributed to the system
      // account (canonical sentinel pattern used across the codebase).
      const mList = await tx
        .update(marketingLists)
        .set({ createdById: SYSTEM_SENTINEL_USER_ID })
        .where(eq(marketingLists.createdById, userId))
        .returning({ id: marketingLists.id });
      const mCamp = await tx
        .update(marketingCampaigns)
        .set({ createdById: SYSTEM_SENTINEL_USER_ID })
        .where(eq(marketingCampaigns.createdById, userId))
        .returning({ id: marketingCampaigns.id });
      const mTpl = await tx
        .update(marketingTemplates)
        .set({ createdById: SYSTEM_SENTINEL_USER_ID })
        .where(eq(marketingTemplates.createdById, userId))
        .returning({ id: marketingTemplates.id });
      const apiK = await tx
        .update(apiKeys)
        .set({ createdById: SYSTEM_SENTINEL_USER_ID })
        .where(eq(apiKeys.createdById, userId))
        .returning({ id: apiKeys.id });
      const eLog = await tx
        .update(emailSendLog)
        .set({ fromUserId: SYSTEM_SENTINEL_USER_ID })
        .where(eq(emailSendLog.fromUserId, userId))
        .returning({ id: emailSendLog.id });
      const iRun = await tx
        .update(importRuns)
        .set({ createdById: SYSTEM_SENTINEL_USER_ID })
        .where(eq(importRuns.createdById, userId))
        .returning({ id: importRuns.id });

      systemReassignedCounts.crmAccounts =
        businessSuccessor === SYSTEM_SENTINEL_USER_ID ? acct.length : 0;
      systemReassignedCounts.contacts =
        businessSuccessor === SYSTEM_SENTINEL_USER_ID ? cont.length : 0;
      systemReassignedCounts.opportunities =
        businessSuccessor === SYSTEM_SENTINEL_USER_ID ? opp.length : 0;
      systemReassignedCounts.tasks =
        businessSuccessor === SYSTEM_SENTINEL_USER_ID ? tsk.length : 0;
      systemReassignedCounts.marketingLists = mList.length;
      systemReassignedCounts.marketingCampaigns = mCamp.length;
      systemReassignedCounts.marketingTemplates = mTpl.length;
      systemReassignedCounts.apiKeys = apiK.length;
      systemReassignedCounts.emailSendLog = eLog.length;
      systemReassignedCounts.importRuns = iRun.length;

      // Finally, delete the user. The remaining FK references are now
      // either reassigned (above), CASCADE children the DB removes, or
      // SET NULL provenance stamps the DB nulls (audit_log.actor_id
      // included — the audit row survives; only the FK nulls).
      await tx.delete(users).where(eq(users.id, userId));
    });

    // Durable async cleanup via the job queue (F-Ω-8). Enqueued outside
    // the transaction so a queue write hiccup cannot roll back the user
    // delete. Failures here log but do not surface as an error to the
    // admin (the DB record is the truth). No `origin` field — the user
    // delete cascade fans out across many leads; origin metadata lives
    // in `metadata.targetUserId` for forensic correlation.
    if (blobPaths.length > 0) {
      try {
        await enqueueJob(
          "blob-cleanup",
          { pathnames: blobPaths },
          {
            actorId: admin.id,
            idempotencyKey: `blob-cleanup:user:${userId}`,
            metadata: {
              originAction: "user.delete",
              targetUserId: userId,
              disposition,
              blobCount: blobPaths.length,
            },
          },
        );
      } catch (err) {
        logger.warn("admin.blob_cleanup_enqueue_after_user_delete_failed", {
          targetUserId: userId,
          blobCount: blobPaths.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
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
        systemReassignedCounts,
      },
    });

    revalidatePath("/admin/users");
    redirect("/admin/users");
  });
}
