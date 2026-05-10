import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { sendgridConfigured } from "@/lib/env";
import { syncSuppressions } from "@/lib/marketing/sendgrid/suppressions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 19 — Hourly reconcile against SendGrid's authoritative
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
    try {
      await db.insert(auditLog).values({
        actorId: null,
        actorEmailSnapshot: "system@cron",
        action: "marketing.suppression.sync",
        targetType: "marketing_suppression",
        targetId: null,
        beforeJson: null,
        afterJson: { ...result, durationMs },
        requestId: null,
        ipAddress: null,
      });
    } catch (auditErr) {
      logger.error("cron.marketing_sync_suppressions.self_audit_failed", {
        errorMessage:
          auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }

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
