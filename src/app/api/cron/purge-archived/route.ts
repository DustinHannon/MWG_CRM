import { NextResponse } from "next/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 4G — daily cron at 10:00 UTC (~04:00 CT). Hard-deletes leads that
 * have been archived ≥ 30 days. Snapshots row data into audit_log for
 * forensic recovery if needed.
 *
 * Configured in vercel.json as:
 *   { "path": "/api/cron/purge-archived", "schedule": "0 10 * * *" }
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
  if (!env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

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

    // Hard-delete cascades through activities, tasks, lead_tags, attachments.
    await db.delete(leads).where(
      and(
        eq(leads.isDeleted, true),
        lt(leads.deletedAt, cutoff),
      ),
    );

    logger.info("cron.purge_archived_completed", {
      processed: candidates.length,
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
