import { NextResponse } from "next/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  deleteBlobsByPathnames,
  gatherBlobsForLeads,
} from "@/lib/blob-cleanup";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

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

    // Snapshot to audit log before delete (best-effort; we still delete on
    // audit failures since the data is by definition >30 days archived).
    for (const lead of candidates) {
      const actor = lead.deletedById ?? lead.ownerId;
      if (!actor) continue;
      await writeAudit({
        actorId: actor,
        action: "lead.purge",
        targetType: "lead",
        targetId: lead.id,
        before: lead as unknown as object,
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

    // 024 — fire-and-forget Vercel Blob cleanup. The cron
    // window is generous (maxDuration=300) but we still don't await the
    // network round-trip per blob — `del()` accepts a batch. Pass the
    // pre-gathered paths directly; re-gathering after the DB delete
    // would find empty (the attachments -> activities -> leads join
    // returns no rows once CASCADE cleared the join chain), causing
    // blobs to leak.
    if (blobPathnames.length > 0) {
      void deleteBlobsByPathnames(blobPathnames).catch((err) => {
        logger.error("blob_cleanup_failure_purge_archived", {
          leadCount: candidateIds.length,
          blobCount: blobPathnames.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
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
