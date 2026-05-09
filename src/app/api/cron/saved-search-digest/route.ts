import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { runSavedSearchDigest } from "@/lib/saved-search-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 3H — daily cron at 14:00 UTC. Runs through every active
 * saved-search subscription, creates in-app notifications + optional
 * email digests.
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  try {
    const summary = await runSavedSearchDigest();
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
