import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { rescoreAllLeads } from "@/lib/scoring/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 4C — daily cron at 09:00 UTC (~03:00 CT). Rescores every active
 * lead so time-decay rules (e.g. `last_activity_within_days`) take effect.
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  try {
    const processed = await rescoreAllLeads();
    logger.info("cron.rescore_leads_completed", { processed });
    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    logger.error("cron.rescore_leads_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Cron job failed" },
      { status: 500 },
    );
  }
}
