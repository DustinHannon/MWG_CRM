import { NextResponse } from "next/server";
import { writeSystemAudit } from "@/lib/audit";
import { AUDIT_EVENTS, AUDIT_SYSTEM_ACTORS } from "@/lib/audit/events";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { runSavedSearchDigest } from "@/lib/saved-search-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * daily cron at 14:00 UTC. Runs through every active
 * saved-search subscription, creates in-app notifications + optional
 * email digests.
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  try {
    const summary = await runSavedSearchDigest();

    // System-initiated cron self-audit. Aggregate only (one row per
    // run, not per subscription), matching the established cron
    // self-audit convention. Field names mirror the runner's
    // `DigestSummary` return type.
    await writeSystemAudit({
      actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.CRON,
      action: AUDIT_EVENTS.SYSTEM_SAVED_SEARCH_DIGEST,
      after: {
        subscriptionsProcessed: summary.processed,
        digestsSent: summary.emailed,
        notified: summary.notified,
        reauth: summary.reauth,
        errors: summary.errors,
      },
    });

    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    logger.error("cron.saved_search_digest_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Cron job failed" },
      { status: 500 },
    );
  }
}
