import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { marketingLists } from "@/db/schema/marketing-lists";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { refreshList } from "@/lib/marketing/lists/refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Daily refresh of marketing-list membership.
 *
 * Picks up to MAX_LISTS_PER_RUN active lists ordered by least-recently
 * refreshed, then re-evaluates each filter against the current leads
 * table. Errors per list are caught so one bad DSL can't kill the
 * whole run. The cron writes its own audit row attributing the work
 * to `system@cron`.
 *
 * Schedule note: the brief calls for a daily cadence; the lead agent
 * adds the entry to vercel.json (NOT this sub-agent).
 */

const MAX_LISTS_PER_RUN = 100;

export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  const start = Date.now();
  const lists = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
    })
    .from(marketingLists)
    .where(eq(marketingLists.isDeleted, false))
    // ORDER BY lastRefreshedAt ASC NULLS FIRST — never-refreshed
    // lists float to the top so a freshly created list gets membership
    // in the next sweep even if a manual refresh wasn't triggered.
    .orderBy(asc(marketingLists.lastRefreshedAt))
    .limit(MAX_LISTS_PER_RUN);

  let succeeded = 0;
  let failed = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  const failures: { id: string; name: string; error: string }[] = [];

  for (const list of lists) {
    try {
      // null actor → cron-attributed; refreshList writes an audit row
      // only when actorId is non-null, so we self-audit at the end of
      // the run instead.
      const result = await refreshList(list.id, null);
      succeeded += 1;
      totalAdded += result.added;
      totalRemoved += result.removed;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ id: list.id, name: list.name, error: message });
      logger.error("cron.marketing_list_refresh.list_failed", {
        listId: list.id,
        listName: list.name,
        errorMessage: message,
      });
    }
  }

  const durationMs = Date.now() - start;
  logger.info("cron.marketing_list_refresh.completed", {
    listsConsidered: lists.length,
    succeeded,
    failed,
    totalAdded,
    totalRemoved,
    durationMs,
  });

  // Self-audit so the activity log records the cron run.
  try {
    await db.insert(auditLog).values({
      actorId: null,
      actorEmailSnapshot: "system@cron",
      action: "marketing.list.refresh_cron",
      targetType: "system",
      targetId: null,
      beforeJson: null,
      afterJson: {
        lists_considered: lists.length,
        succeeded,
        failed,
        total_added: totalAdded,
        total_removed: totalRemoved,
        duration_ms: durationMs,
        failures: failures.slice(0, 20),
      },
      requestId: null,
      ipAddress: null,
    });
  } catch (auditErr) {
    logger.error("cron.marketing_list_refresh.self_audit_failed", {
      errorMessage:
        auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  return NextResponse.json({
    ok: true,
    listsConsidered: lists.length,
    succeeded,
    failed,
    totalAdded,
    totalRemoved,
    durationMs,
  });
}
