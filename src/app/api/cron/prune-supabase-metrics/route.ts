import { NextResponse } from "next/server";
import { lt, sql } from "drizzle-orm";

import { db } from "@/db";
import { supabaseMetrics } from "@/db/schema/supabase-metrics";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

/**
 * Daily retention prune for `supabase_metrics`. Deletes rows older
 * than 7 days. Runs at 03:00 UTC.
 *
 * Configured in vercel.json as:
 *   { "path": "/api/cron/prune-supabase-metrics", "schedule": "0 3 * * *" }
 *
 * Single statement against a bounded predicate. Cannot affect any
 * other table. Cannot affect rows newer than 7 days.
 *
 * Failure contract identical to the scrape handler: never throw,
 * never return 5xx for transient failures.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  const startedAt = Date.now();

  try {
    const result = await db
      .delete(supabaseMetrics)
      .where(lt(supabaseMetrics.time, sql`now() - interval '7 days'`));
    // postgres-js driver: the delete result is a RowList whose `count`
    // carries the affected-row count. Reading it avoids materializing
    // every deleted row just to size the batch.
    const deletedRows = result.count;

    const durationMs = Date.now() - startedAt;
    logger.info("supabase_metrics.prune.completed", {
      deletedRows,
      durationMs,
    });

    return NextResponse.json({ ok: true, deletedRows, durationMs });
  } catch (err) {
    logger.error("supabase_metrics.prune.failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "prune_failed" },
      { status: 200 },
    );
  }
}
