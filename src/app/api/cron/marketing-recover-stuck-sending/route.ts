import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { writeSystemAudit } from "@/lib/audit";
import { AUDIT_SYSTEM_ACTORS } from "@/lib/audit/events";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Recover campaigns wedged in `sending`.
 *
 * The campaign send pipeline (`sendCampaign`) already flips the row to
 * `failed` when a pre-batch step throws and when a caught error occurs
 * inside the batch loop. What it cannot handle is a HARD process kill
 * mid-batch — SIGKILL / OOM / instance recycle — where no catch runs at
 * all. That leaves `marketing_campaigns.status = 'sending'`
 * forever: the scheduled-campaign cron only ever claims `scheduled`
 * rows, and cancel / resend / delete all refuse a `sending` row, so the
 * campaign becomes permanently un-actionable from the UI.
 *
 * This sweep flips any campaign stuck in `sending` past the staleness
 * threshold to `failed` with a forensic reason, restoring
 * cancel/clone/delete eligibility and surfacing it on the failures
 * surface. Recipients SendGrid already accepted were delivered (the
 * webhook reconciles those independently); only the campaign lifecycle
 * is unwedged here.
 *
 * Safe to run repeatedly (idempotent): a campaign already moved out of
 * `sending` no longer matches the predicate, so re-runs are no-ops.
 *
 * The staleness predicate is `updated_at < now() - STUCK_MINUTES` —
 * every in-flight batch bumps `marketing_campaigns.updated_at` per slice
 * (the `total_sent` increment in `sendCampaign`), so a genuinely-active
 * send keeps its `updated_at` fresh and is never swept; only a dead one
 * ages out. Atomic conditional UPDATE — Supavisor-safe (no advisory
 * locks, STANDARDS §9.2).
 *
 * Schedule: every 15 minutes (matches the staleness threshold).
 * Configured in vercel.json.
 */

const STUCK_MINUTES = 15;

interface RecoveredCampaignRow {
  id: string;
}

export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  const startedAt = Date.now();
  try {
    const result = await db.execute(sql`
      WITH d AS (
        UPDATE marketing_campaigns
        SET status = 'failed',
            failure_reason = 'Send interrupted (process terminated mid-batch); auto-recovered by the stuck-sending sweep. Recipients already accepted by the email provider were delivered. Clone this campaign to send the remainder.',
            updated_at = now()
        WHERE status = 'sending'
          AND is_deleted = false
          AND updated_at < now() - (${STUCK_MINUTES} || ' minutes')::interval
        RETURNING id
      )
      SELECT id FROM d
    `);

    const recoveredRows = readRecoveredRows(result);
    const recovered = recoveredRows.length;
    const durationMs = Date.now() - startedAt;

    // Per-campaign audit. Lifecycle/governance events are ALWAYS
    // per-event (never aggregated) so the forensic trail records each
    // recovered campaign individually. Best-effort — an audit-write
    // failure must not fail the sweep (the data is already correct).
    for (const row of recoveredRows) {
      await writeSystemAudit({
        actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.CRON,
        action: MARKETING_AUDIT_EVENTS.CAMPAIGN_RECOVER_STUCK,
        targetType: "marketing_campaign",
        targetId: row.id,
        after: {
          recoveredFrom: "sending",
          recoveredTo: "failed",
          stuckMinutes: STUCK_MINUTES,
        },
      });
    }

    logger.info("cron.marketing_recover_stuck_sending.completed", {
      recovered,
      durationMs,
    });

    await writeSystemAudit({
      actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.CRON,
      action: "system.marketing_recover_stuck_sending",
      targetType: "system",
      after: {
        recovered,
        stuck_minutes: STUCK_MINUTES,
        duration_ms: durationMs,
      },
    });

    return NextResponse.json({ ok: true, recovered });
  } catch (err) {
    logger.error("cron.marketing_recover_stuck_sending.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}

function readRecoveredRows(result: unknown): RecoveredCampaignRow[] {
  // postgres-js returns an array of result rows. Drizzle's
  // `db.execute(sql)` returns the same shape. We `SELECT id FROM d` so
  // each row is `{ id: string }`.
  if (!Array.isArray(result)) return [];
  const out: RecoveredCampaignRow[] = [];
  for (const row of result) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id === "string") out.push({ id });
  }
  return out;
}
