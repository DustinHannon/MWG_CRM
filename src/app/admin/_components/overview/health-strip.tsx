import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { emailSendLog } from "@/db/schema/email-send-log";
import { getErrorPatterns } from "@/lib/observability/server-logs-queries";
import { logger } from "@/lib/logger";
import { OverviewTile } from "./overview-ui";

/**
 * System-health strip: three independent 24h signals. Each source is
 * isolated — a slow/unavailable Better Stack query or a DB hiccup
 * degrades only its own tile to "—", never the strip or the page.
 * Server component; fetched fresh per request (no unstable_cache).
 */
export async function HealthStrip() {
  const [fivexx, dbCounts] = await Promise.all([
    count5xx24h(),
    countDb24h(),
  ]);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <OverviewTile
        label="5xx errors (24h)"
        value={fivexx ?? "—"}
        attention={typeof fivexx === "number" && fivexx > 0}
        sub={fivexx === null ? "Source unavailable" : "Server-side failures"}
      />
      <OverviewTile
        label="Email send failures (24h)"
        value={dbCounts ? dbCounts.emailFailures : "—"}
        attention={!!dbCounts && dbCounts.emailFailures > 0}
        sub={dbCounts ? "Failed or preflight-blocked" : "Source unavailable"}
      />
      <OverviewTile
        label="Audit events (24h)"
        value={dbCounts ? dbCounts.auditEvents : "—"}
        sub={dbCounts ? "Recorded mutations" : "Source unavailable"}
      />
    </div>
  );
}

async function count5xx24h(): Promise<number | null> {
  try {
    const rows = await getErrorPatterns("24h");
    return rows.reduce((acc, r) => acc + Number(r.n ?? 0), 0);
  } catch (err) {
    // diagnostic: Better Stack is best-effort here; the tile degrades
    // to "—" rather than failing the admin landing page.
    logger.error("admin_overview.health.5xx_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function countDb24h(): Promise<{
  emailFailures: number;
  auditEvents: number;
} | null> {
  try {
    const rows = await db.execute<{
      email_failures: number;
      audit_events: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM ${emailSendLog}
           WHERE status IN ('failed','blocked_preflight')
             AND queued_at > now() - interval '24 hours') AS email_failures,
        (SELECT count(*)::int FROM ${auditLog}
           WHERE created_at > now() - interval '24 hours') AS audit_events
    `);
    const r = rows[0];
    return {
      emailFailures: r?.email_failures ?? 0,
      auditEvents: r?.audit_events ?? 0,
    };
  } catch (err) {
    logger.error("admin_overview.health.db_counts_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
