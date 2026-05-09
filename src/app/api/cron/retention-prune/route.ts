import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { apiUsageLog } from "@/db/schema/api-keys";
import { emailSendLog } from "@/db/schema/email-send-log";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Phase 13 — daily retention sweep. Hard-deletes rows older than the
 * configured retention window. Currently:
 *   - audit_log:        730 days
 *   - api_usage_log:    730 days
 *   - email_send_log:   730 days  (Phase 15 — added alongside foundation)
 *
 * All windows are explicit constants below so future tuning is a
 * single-line edit. The cron writes its own audit entry recording how
 * many rows it removed (best-effort — if the audit insert fails we
 * still consider the prune successful since the data is by definition
 * past its retention horizon).
 *
 * Schedule: 0 8 * * * (08:00 UTC, ~03:00 CT). Configured in vercel.json.
 */

const AUDIT_RETENTION_DAYS = 730;
const API_USAGE_RETENTION_DAYS = 730;
const EMAIL_SEND_RETENTION_DAYS = 730;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.CRON_SECRET ?? ""}`;
  if (!env.CRON_SECRET || auth !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const auditDeleted = await db.execute(sql`
      WITH d AS (
        DELETE FROM ${auditLog}
        WHERE created_at < now() - (${AUDIT_RETENTION_DAYS} || ' days')::interval
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM d
    `);
    const apiUsageDeleted = await db.execute(sql`
      WITH d AS (
        DELETE FROM ${apiUsageLog}
        WHERE created_at < now() - (${API_USAGE_RETENTION_DAYS} || ' days')::interval
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM d
    `);
    // Phase 15 — email_send_log retains forensic records of every
    // send attempt (success, failure, blocked). Same 730d window as
    // audit_log so admins can correlate failure rows with the audit
    // entry that triggered them.
    const emailSendDeleted = await db.execute(sql`
      WITH d AS (
        DELETE FROM ${emailSendLog}
        WHERE queued_at < now() - (${EMAIL_SEND_RETENTION_DAYS} || ' days')::interval
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM d
    `);

    const auditN = readCount(auditDeleted);
    const apiUsageN = readCount(apiUsageDeleted);
    const emailSendN = readCount(emailSendDeleted);

    logger.info("cron.retention_prune.completed", {
      auditDeleted: auditN,
      apiUsageDeleted: apiUsageN,
      emailSendDeleted: emailSendN,
    });

    // Self-audit so the activity log shows the cron's own work.
    try {
      await db.insert(auditLog).values({
        actorId: null,
        actorEmailSnapshot: "system@cron",
        action: "system.retention_prune",
        targetType: "system",
        targetId: null,
        beforeJson: null,
        afterJson: {
          audit_deleted: auditN,
          api_usage_deleted: apiUsageN,
          email_send_deleted: emailSendN,
          audit_retention_days: AUDIT_RETENTION_DAYS,
          api_usage_retention_days: API_USAGE_RETENTION_DAYS,
          email_send_retention_days: EMAIL_SEND_RETENTION_DAYS,
        },
        requestId: null,
        ipAddress: null,
      });
    } catch (err) {
      logger.error("cron.retention_prune.self_audit_failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({
      ok: true,
      auditDeleted: auditN,
      apiUsageDeleted: apiUsageN,
      emailSendDeleted: emailSendN,
    });
  } catch (err) {
    logger.error("cron.retention_prune.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}

function readCount(result: unknown): number {
  // postgres-js returns an array of result rows. Drizzle's
  // `db.execute(sql)` returns the same shape. We wrote `SELECT
  // count(*)::int AS n FROM d` so the first row has `{ n: number }`.
  if (Array.isArray(result) && result.length > 0) {
    const row = result[0] as { n?: number };
    return typeof row?.n === "number" ? row.n : 0;
  }
  return 0;
}
