import "server-only";
import { logger } from "@/lib/logger";
import { eq } from "drizzle-orm";
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
 * Collect every blob pathname attached to the given lead's activities.
 * Call BEFORE deleting the lead — after the DB delete the join rows are
 * gone and we can no longer look them up.
 */
export async function gatherBlobsForLead(leadId: string): Promise<string[]> {
  const rows = await db
    .select({ pathname: attachments.blobPathname })
    .from(attachments)
    .innerJoin(activities, eq(activities.id, attachments.activityId))
    .where(eq(activities.leadId, leadId));
  return rows.map((r) => r.pathname);
}

/** One-shot helper: gather + delete blobs for a single lead. */
export async function cleanupBlobsForLead(leadId: string): Promise<void> {
  const paths = await gatherBlobsForLead(leadId);
  await deleteBlobs(paths);
}

/**
 * Gather every blob pathname for every lead owned by the given user. Used
 * by the admin "delete user with cascade-delete leads" flow (Phase 2F.4).
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

export async function cleanupBlobsForUser(userId: string): Promise<void> {
  const paths = await gatherBlobsForUser(userId);
  await deleteBlobs(paths);
}

/**
 * Used by the admin "delete all activities" / "delete all leads" data
 * actions: collect every blob pathname currently in attachments. Heavier
 * than the per-lead version — only call from explicit admin flows.
 */
export async function gatherAllAttachmentBlobs(): Promise<string[]> {
  const rows = await db
    .select({ pathname: attachments.blobPathname })
    .from(attachments);
  return rows.map((r) => r.pathname);
}

export async function cleanupAllAttachmentBlobs(): Promise<void> {
  const paths = await gatherAllAttachmentBlobs();
  await deleteBlobs(paths);
}
