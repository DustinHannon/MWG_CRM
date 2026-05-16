import { NextResponse } from "next/server";
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { recentViews } from "@/db/schema/recent-views";
import { gatherBlobsForLeads } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { writeAuditBatch } from "@/lib/audit";
import {
  SYSTEM_SENTINEL_USER_EMAIL,
  SYSTEM_SENTINEL_USER_ID,
} from "@/lib/constants/system-users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * daily cron at 10:00 UTC (~04:00 CT). Hard-deletes leads that
 * have been archived ≥ 30 days. Snapshots row data into audit_log for
 * forensic recovery if needed.
 *
 * Configured in vercel.json as:
 * { "path": "/api/cron/purge-archived", "schedule": "0 10 * * *" }
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  try {
    // Find archived rows older than 30 days.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Batch the select -> snapshot -> gather -> delete -> enqueue loop
    // so peak memory is O(BATCH) and each iteration's audit/delete is
    // bounded. The prior single unbounded `SELECT *` + full-row
    // snapshot array could OOM or hit maxDuration at scale.
    const BATCH = 1000;
    let totalProcessed = 0;
    let totalBlobsQueued = 0;

    for (;;) {
      const candidates = await db
        .select()
        .from(leads)
        .where(
          and(eq(leads.isDeleted, true), lt(leads.deletedAt, cutoff)),
        )
        .limit(BATCH);

      if (candidates.length === 0) break;
      const candidateIds = candidates.map((c) => c.id);

      // 024 — gather attachment blob pathnames BEFORE the DB delete;
      // after CASCADE the join rows are gone and the blobs become
      // unrecoverable orphans. Gather runs on the candidate superset
      // (pre-delete); gather failure is non-fatal — purge proceeds.
      let blobPathnames: string[] = [];
      try {
        blobPathnames = await gatherBlobsForLeads(candidateIds);
      } catch (err) {
        logger.error("blob_cleanup_gather_failure_purge_archived", {
          leadCount: candidateIds.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      // Delete ONLY this batch by id, re-asserting the purge predicate.
      // RETURNING gives the rows that were actually deleted. A lead
      // restored (is_deleted=false) between this batch's SELECT and the
      // DELETE is excluded by the predicate AND was id-targeted, so the
      // audit set below is built from `deleted` (the real delete set),
      // not the candidate snapshot. This closes the restore-during-
      // purge stray-audit skew (§19.5.3 — intentional-race contract:
      // a restored-mid-purge lead produces NO lead.purge audit and is
      // not deleted; the blob gather superset for it is harmless
      // because its blobs were not deleted and the handler is
      // 404-tolerant). Hard-delete cascades through activities, tasks,
      // lead_tags, attachments.
      const deleted = await db
        .delete(leads)
        .where(
          and(
            inArray(leads.id, candidateIds),
            eq(leads.isDeleted, true),
            lt(leads.deletedAt, cutoff),
          ),
        )
        .returning();

      // F-Ω-6: snapshot to audit log. Previously we skipped leads with
      // no deletedById AND no ownerId, which silently destroyed the
      // forensic record for orphan-owner leads. Use the system sentinel
      // as last-resort actor so the pre-purge snapshot always lands.
      //
      // F-Ω-7: per-record awaits replaced with writeAuditBatch (one
      // INSERT chunked at 500 rows) so each batch costs O(1)
      // round-trips. Built from `deleted` (RETURNING) so the audit set
      // exactly matches what was removed.
      //
      // Group events by actor so each actor's writeAuditBatch resolves
      // its email_snapshot exactly once.
      if (deleted.length > 0) {
        const eventsByActor = new Map<
          string,
          Array<{
            action: string;
            targetType: string;
            targetId: string;
            before: object;
          }>
        >();
        for (const lead of deleted) {
          const actor =
            lead.deletedById ?? lead.ownerId ?? SYSTEM_SENTINEL_USER_ID;
          const bucket = eventsByActor.get(actor) ?? [];
          bucket.push({
            action: "lead.purge",
            targetType: "lead",
            targetId: lead.id,
            before: lead as unknown as object,
          });
          eventsByActor.set(actor, bucket);
        }
        for (const [actorId, events] of eventsByActor) {
          await writeAuditBatch({
            actorId,
            // Hand a snapshot for the sentinel directly so the helper
            // can skip the lookup round-trip for that special-cased id.
            ...(actorId === SYSTEM_SENTINEL_USER_ID
              ? { actorEmailSnapshot: SYSTEM_SENTINEL_USER_EMAIL }
              : {}),
            events,
          });
        }
      }

      // recent_views has no polymorphic FK (free-text entity_type), so
      // the hard delete above does NOT cascade the purged leads' Cmd+K
      // recent-view rows — purge them explicitly per batch. Best-effort:
      // a failure here must never abort the cron run (the resolve-time
      // is_deleted gate already hid these from users; this reclaims the
      // rows). Keyed off `deleted` (the real delete set), not the
      // candidate superset, so a restored-mid-purge lead's recent-view
      // row is correctly left intact.
      if (deleted.length > 0) {
        try {
          await db
            .delete(recentViews)
            .where(
              and(
                eq(recentViews.entityType, "lead"),
                inArray(
                  recentViews.entityId,
                  deleted.map((d) => d.id),
                ),
              ),
            );
        } catch (err) {
          logger.error("recent_views.cleanup_failed", {
            entityType: "lead",
            ids: deleted.map((d) => d.id),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Durable async cleanup via the job queue (F-Ω-8). Per-batch
      // idempotency key: a cron re-run that re-selects the same
      // not-yet-deleted batch produces the same key and dedupes the
      // duplicate cleanup job. No `origin` — the purge runs across N
      // leads, not one entity.
      if (blobPathnames.length > 0) {
        try {
          await enqueueJob(
            "blob-cleanup",
            { pathnames: blobPathnames },
            {
              idempotencyKey: `blob-cleanup:cron.purge_archived:${candidateIds[0]}:${candidateIds.length}`,
              metadata: {
                originAction: "cron.purge_archived",
                leadCount: candidateIds.length,
                sampleLeadIds: candidateIds.slice(0, 10),
                blobCount: blobPathnames.length,
              },
            },
          );
        } catch (err) {
          logger.error("blob_cleanup_enqueue_failure_purge_archived", {
            leadCount: candidateIds.length,
            blobCount: blobPathnames.length,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      totalProcessed += deleted.length;
      totalBlobsQueued += blobPathnames.length;

      // Short final batch means the candidate pool is drained.
      if (candidates.length < BATCH) break;
    }

    if (totalProcessed === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    logger.info("cron.purge_archived_completed", {
      processed: totalProcessed,
      blobsQueued: totalBlobsQueued,
    });
    return NextResponse.json({ ok: true, processed: totalProcessed });
  } catch (err) {
    logger.error("cron.purge_archived_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Cron job failed" },
      { status: 500 },
    );
  }
}
