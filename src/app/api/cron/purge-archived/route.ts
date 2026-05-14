import { NextResponse } from "next/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
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
    const candidates = await db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.isDeleted, true),
          lt(leads.deletedAt, cutoff),
        ),
      );

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    // F-Ω-6: snapshot to audit log before delete. Previously we skipped
    // leads with no deletedById AND no ownerId (`if (!actor) continue`),
    // which silently destroyed the forensic record for orphan-owner
    // leads that aged into the 30-day purge window. Use the system
    // sentinel as last-resort actor so the row's pre-purge snapshot
    // always lands.
    //
    // F-Ω-7: per-record awaits replaced with a single writeAuditBatch
    // (one INSERT chunked at 500 rows per src/lib/audit.ts) so a purge
    // of 1000 leads costs O(1) round-trips instead of O(N). Each row's
    // forensic snapshot is still independently queryable.
    //
    // Group events by actor so each actor's writeAuditBatch resolves
    // its email_snapshot exactly once. Sentinel actor lands in its
    // own group with the canonical sentinel email.
    const eventsByActor = new Map<
      string,
      Array<{
        action: string;
        targetType: string;
        targetId: string;
        before: object;
      }>
    >();
    for (const lead of candidates) {
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

    // 024 — gather attachment blob pathnames BEFORE the DB
    // delete; after CASCADE the join rows are gone and the blobs become
    // unrecoverable orphans. Gather failure is non-fatal — purge proceeds.
    const candidateIds = candidates.map((c) => c.id);
    let blobPathnames: string[] = [];
    try {
      blobPathnames = await gatherBlobsForLeads(candidateIds);
    } catch (err) {
      logger.error("blob_cleanup_gather_failure_purge_archived", {
        leadCount: candidateIds.length,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    // Hard-delete cascades through activities, tasks, lead_tags, attachments.
    await db.delete(leads).where(
      and(
        eq(leads.isDeleted, true),
        lt(leads.deletedAt, cutoff),
      ),
    );

    // Durable async cleanup via the job queue (F-Ω-8). Replaces the
    // prior `void deleteBlobsByPathnames(...).catch(...)` — STANDARDS
    // §19.11.3 documents the durability gap that pattern carried. The
    // cron has a generous maxDuration but the actual `del()` work is
    // off-cron now: the enqueue is fast; the worker cron sweeps the
    // queue every minute and processes batches with retry budget.
    //
    // No `origin` set: the purge runs across N leads, not one entity.
    // candidateIds (sample) goes into metadata for correlation.
    if (blobPathnames.length > 0) {
      try {
        await enqueueJob(
          "blob-cleanup",
          { pathnames: blobPathnames },
          {
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

    logger.info("cron.purge_archived_completed", {
      processed: candidates.length,
      blobsQueued: blobPathnames.length,
    });
    return NextResponse.json({ ok: true, processed: candidates.length });
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

void sql;
