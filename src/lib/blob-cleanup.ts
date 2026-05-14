import "server-only";
import { eq, inArray } from "drizzle-orm";
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
 * delete the rows are gone). The actual `del()` work now lives in the
 * durable async job queue (F-Ω-8) — callers enqueue a `blob-cleanup` job
 * via `enqueueJob('blob-cleanup', { pathnames }, ...)` from
 * `@/lib/jobs/queue`; the handler at `src/lib/jobs/handlers/blob-cleanup.ts`
 * owns the actual deletion with retry budget + dead-letter on failure.
 *
 * Failure policy: a Blob delete failure must NOT roll back the DB delete.
 * The DB record is the source of truth for "does this lead exist"; orphan
 * blobs are wasted bytes but not a correctness issue. The queue handles
 * that policy now (failures retry; permanently broken jobs land in
 * dead-letter for admin review).
 *
 * Pre-F-Ω-8 this module exported `deleteBlobsByPathnames` for callers to
 * invoke directly via `void deleteBlobsByPathnames(...).catch(...)`. That
 * pattern was not durable — STANDARDS §19.11.3 documents the lambda
 * termination loss vector. The export is removed (rather than left with
 * an `@deprecated` marker) following the same hygiene precedent as
 * commit 63e4b63 (`Remove the broken cleanupBlobsForLeads /
 * cleanupBlobsForUser exports so future call sites can't repeat the
 * mistake`).
 */

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

