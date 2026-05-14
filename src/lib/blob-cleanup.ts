import "server-only";
import { logger } from "@/lib/logger";
import { eq, inArray } from "drizzle-orm";
import { del } from "@vercel/blob";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";

/**
 * Vercel Blob is not part of the Postgres FK graph — cascading deletes on
 * the DB will remove `attachments` rows but the actual blob objects in the
 * Vercel Blob store will linger as orphans forever unless we clean them up
 * explicitly.
 *
 * These helpers gather the blob pathnames BEFORE the DB delete (after the
 * delete the rows are gone) and call `del()` on them.
 *
 * Failure policy: a Blob delete failure must NOT roll back the DB delete.
 * The DB record is the source of truth for "does this lead exist"; orphan
 * blobs are wasted bytes but not a correctness issue. We log and move on.
 */

async function deleteBlobs(pathnames: string[]): Promise<void> {
  if (pathnames.length === 0) return;
  try {
    // @vercel/blob `del` accepts a single url/pathname or an array.
    await del(pathnames);
  } catch (err) {
    logger.error("blob_cleanup.del_failed", {
      blobCount: pathnames.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete a pre-gathered list of blob pathnames. Use this when the parent
 * DB rows have ALREADY been deleted and you have the paths captured from
 * a prior `gatherBlobsFor*` call.
 *
 * `cleanupBlobsForLeads` / `cleanupBlobsForUser` re-gather paths via the
 * `attachments -> activities -> leads` join, which returns empty after
 * the parent leads have been deleted (CASCADE cleared the join rows).
 * Callers that ran the DB delete before invoking cleanup MUST use this
 * helper with the previously captured paths or the cleanup is a no-op
 * and blobs leak.
 *
 * Failure policy unchanged: deletion failures log and return; the
 * primary DB delete is the source of truth.
 */
export async function deleteBlobsByPathnames(
  pathnames: string[],
): Promise<void> {
  await deleteBlobs(pathnames);
}

/**
 * gather every blob pathname attached to any of the given
 * leads' activities. Used by hard-delete and the purge-archived cron.
 * Call BEFORE the DB delete (after which the join rows are gone).
 */
export async function gatherBlobsForLeads(
  leadIds: string[],
): Promise<string[]> {
  if (leadIds.length === 0) return [];
  const rows = await db
    .select({ pathname: attachments.blobPathname })
    .from(attachments)
    .innerJoin(activities, eq(activities.id, attachments.activityId))
    .where(inArray(activities.leadId, leadIds));
  return rows.map((r) => r.pathname);
}

/**
 * Gather every blob pathname for every lead owned by the given user. Used
 * by the admin "delete user with cascade-delete leads" flow.
 * Call BEFORE the DELETE FROM leads WHERE owner_id = userId.
 */
export async function gatherBlobsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ pathname: attachments.blobPathname })
    .from(attachments)
    .innerJoin(activities, eq(activities.id, attachments.activityId))
    .innerJoin(leads, eq(leads.id, activities.leadId))
    .where(eq(leads.ownerId, userId));
  return rows.map((r) => r.pathname);
}

/**
 * Multi-entity dispatcher for gathering blob pathnames before a hard-delete
 * of any activity-parent entity (lead / account / contact / opportunity).
 *
 * The `activities` table carries four nullable parent FKs (lead_id /
 * account_id / contact_id / opportunity_id), each with ON DELETE CASCADE
 * back to its parent. A hard-delete of a parent cascade-purges activities
 * AND attachments rows, but the Vercel Blob objects remain orphaned —
 * the same problem `gatherBlobsForLeads` solves for leads. This helper
 * extends that contract to the other three activity-parent entities.
 *
 * Tasks are excluded — the `tasks` table is not an activity-parent
 * (attachments cascade off `activities` only, not `tasks`).
 *
 * STANDARDS §19.4 governs the hard-delete blob cleanup contract.
 */
export type ActivityParentKind = "lead" | "account" | "contact" | "opportunity";

export async function gatherBlobsForActivityParent(
  kind: ActivityParentKind,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  // The Drizzle column reference is selected dynamically by `kind`.
  // `inArray` against any one of the four parent FKs gives the same
  // attachments -> activities pre-cascade row set the per-entity
  // helpers would produce.
  const parentCol =
    kind === "lead"
      ? activities.leadId
      : kind === "account"
        ? activities.accountId
        : kind === "contact"
          ? activities.contactId
          : activities.opportunityId;
  const rows = await db
    .select({ pathname: attachments.blobPathname })
    .from(attachments)
    .innerJoin(activities, eq(activities.id, attachments.activityId))
    .where(inArray(parentCol, ids));
  return rows.map((r) => r.pathname);
}

