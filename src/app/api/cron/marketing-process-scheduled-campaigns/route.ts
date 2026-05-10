import { NextResponse } from "next/server";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { sendCampaign } from "@/lib/marketing/sendgrid/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 21 — Scheduled-campaign processor.
 *
 * Picks up campaigns whose `scheduled_for` has elapsed and runs them
 * through the SendGrid pipeline (`sendCampaign`). Designed for one
 * cadence per minute via Vercel cron; each invocation grabs a small
 * batch and processes them serially so a Vercel function never burns
 * past its 300s wall.
 *
 * Pickup is atomic: the UPDATE … WHERE status='scheduled' RETURNING
 * pattern claims a campaign in one round-trip. A second cron worker (or
 * a manual /api/cron call during deploy) cannot grab the same row;
 * `RETURNING` shows zero rows when the predicate doesn't match.
 *
 * Per-campaign failures are caught and logged; they don't fail the
 * cron's own response so subsequent campaigns still process. The
 * `failed` status + `failure_reason` recorded by `sendCampaign` is the
 * forensic record.
 */

const PICKUP_LIMIT = 10;

export async function GET(req: Request): Promise<Response> {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  let picked = 0;
  let completed = 0;
  let failed = 0;
  const startedAt = Date.now();

  try {
    const candidates = await db
      .select({
        id: marketingCampaigns.id,
        scheduledFor: marketingCampaigns.scheduledFor,
      })
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.status, "scheduled"),
          eq(marketingCampaigns.isDeleted, false),
          lte(marketingCampaigns.scheduledFor, sql`now()`),
        ),
      )
      .orderBy(asc(marketingCampaigns.scheduledFor))
      .limit(PICKUP_LIMIT);

    for (const candidate of candidates) {
      // Atomic claim — only proceed if the row is still 'scheduled'.
      // A racing worker that claims first wins; we skip silently.
      const claimed = await db
        .update(marketingCampaigns)
        .set({ status: "sending", updatedAt: sql`now()` })
        .where(
          and(
            eq(marketingCampaigns.id, candidate.id),
            eq(marketingCampaigns.status, "scheduled"),
          ),
        )
        .returning({ id: marketingCampaigns.id });
      if (claimed.length === 0) continue;
      picked++;

      try {
        await sendCampaign(candidate.id);
        completed++;
      } catch (err) {
        failed++;
        // sendCampaign already wrote a `marketing.campaign.send_failed`
        // audit row and flipped status='failed' before throwing. We
        // just log here so the cron's structured log line carries the
        // per-campaign failure reason.
        logger.error("cron.marketing_process_scheduled.campaign_failed", {
          campaignId: candidate.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.error("cron.marketing_process_scheduled.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }

  logger.info("cron.marketing_process_scheduled.completed", {
    picked,
    completed,
    failed,
    durationMs: Date.now() - startedAt,
  });

  // Self-audit (best-effort) so the activity log shows the cron's work.
  try {
    await db.insert(auditLog).values({
      actorId: null,
      actorEmailSnapshot: "system@cron",
      action: "system.marketing_process_scheduled",
      targetType: "system",
      targetId: null,
      beforeJson: null,
      afterJson: {
        picked,
        completed,
        failed,
        duration_ms: Date.now() - startedAt,
      },
      requestId: null,
      ipAddress: null,
    });
  } catch (err) {
    logger.error(
      "cron.marketing_process_scheduled.self_audit_failed",
      {
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
  }

  return NextResponse.json({
    ok: true,
    picked,
    completed,
    failed,
  });
}
