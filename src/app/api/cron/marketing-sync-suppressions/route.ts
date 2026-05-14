import { NextResponse } from "next/server";
import { writeSystemAudit } from "@/lib/audit";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { sendgridConfigured } from "@/lib/env";
import { syncSuppressions } from "@/lib/marketing/sendgrid/suppressions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Hourly reconcile against SendGrid's authoritative
 * suppression lists. Fills gaps left by webhook drops or manual
 * console-side suppressions.
 *
 * Schedule: 0 * * * * (top of every hour). Configured in vercel.json.
 */
export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  if (!sendgridConfigured) {
    logger.info("cron.marketing_sync_suppressions.skipped_unconfigured");
    return NextResponse.json({ ok: true, skipped: "sendgrid_not_configured" });
  }

  const start = Date.now();
  try {
    const result = await syncSuppressions();
    const durationMs = Date.now() - start;

    logger.info("cron.marketing_sync_suppressions.completed", {
      ...result,
      durationMs,
    });

    // System-initiated; actor_id null (FK is SET NULL safe). Mirrors the
    // retention-prune cron's self-audit pattern.
    await writeSystemAudit({
      actorEmailSnapshot: "system@cron",
      action: "marketing.suppression.sync",
      targetType: "marketing_suppression",
      after: { ...result, durationMs },
    });

    return NextResponse.json({ ok: true, ...result, durationMs });
  } catch (err) {
    logger.error("cron.marketing_sync_suppressions.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "sync_failed" },
      { status: 500 },
    );
  }
}
