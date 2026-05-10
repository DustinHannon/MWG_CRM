import { NextResponse } from "next/server";
import { and, count, eq, ilike, sql, desc } from "drizzle-orm";
import { db } from "@/db";
import { importRecords, importRuns } from "@/db/schema/d365-imports";
import { auditLog } from "@/db/schema/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";

/**
 * Phase 23 — Polling fallback endpoint for the admin run live-progress
 * panel. The `useRunRealtime` hook (in
 * `src/components/admin/d365-import/use-run-realtime.ts`) prefers the
 * Supabase Realtime broadcast channel `d365-import-run:<runId>`; this
 * route is the 5-second fallback when Realtime is unavailable
 * (SUPABASE_SERVICE_ROLE_KEY missing, network blocked, channel timeout
 * exceeded).
 *
 * Response shape MUST match `RunSnapshot` in use-run-realtime.ts.
 *
 * Auth: admin only (per Phase 23 brief — only admins see imports).
 */

export const dynamic = "force-dynamic";

const VALID_STATUS = new Set([
  "created",
  "fetching",
  "mapping",
  "reviewing",
  "committing",
  "paused_for_review",
  "completed",
  "aborted",
]);

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export async function GET(_req: Request, ctx: RouteParams) {
  await requireAdmin();

  const { runId } = await ctx.params;
  // Sanity-check the runId is a UUID before using it in the query.
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }

  const runRow = await db
    .select({
      id: importRuns.id,
      status: importRuns.status,
      notes: importRuns.notes,
      entityType: importRuns.entityType,
      cursor: importRuns.cursor,
    })
    .from(importRuns)
    .where(eq(importRuns.id, runId))
    .limit(1);

  if (!runRow[0]) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  const run = runRow[0];

  // Aggregate per-status record counts for this run across all batches.
  // import_records is joined on batch_id → import_batches.run_id.
  const counterRows = await db
    .select({
      status: importRecords.status,
      n: count(importRecords.id),
    })
    .from(importRecords)
    .innerJoin(
      sql`(SELECT id FROM import_batches WHERE run_id = ${runId}) AS rb`,
      sql`rb.id = ${importRecords.batchId}`,
    )
    .groupBy(importRecords.status);

  const counters = {
    fetched: 0,
    mapped: 0,
    approved: 0,
    rejected: 0,
    committed: 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of counterRows) {
    const n = Number(r.n ?? 0);
    if (r.status === "pending") counters.fetched += n;
    else if (r.status === "mapped" || r.status === "review") {
      counters.mapped += n;
      counters.fetched += n;
    } else if (r.status === "approved") {
      counters.approved += n;
      counters.fetched += n;
      counters.mapped += n;
    } else if (r.status === "rejected") {
      counters.rejected += n;
      counters.fetched += n;
      counters.mapped += n;
    } else if (r.status === "committed") {
      counters.committed += n;
      counters.fetched += n;
      counters.mapped += n;
      counters.approved += n;
    } else if (r.status === "skipped") {
      counters.skipped += n;
      counters.fetched += n;
    } else if (r.status === "failed") {
      counters.failed += n;
      counters.fetched += n;
    }
  }

  // Last N d365.import.* events for this run, newest first.
  // Hard-bounded for safety even though admin-gated — defends
  // against a future regression that drops the auth check.
  const AUDIT_LIMIT = 10;
  const auditRows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      after: auditLog.afterJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "import_run"),
        eq(auditLog.targetId, runId),
        ilike(auditLog.action, "d365.import.%"),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(AUDIT_LIMIT);

  const logs = auditRows.map((r) => ({
    id: r.id,
    level: classifyAuditLevel(r.action),
    message: r.action,
    detail: stringifyDetail(r.after),
    at: r.createdAt.toISOString(),
  }));

  // Halt reason from the JSON-line notes stream — only meaningful when
  // status is paused_for_review.
  const haltReason =
    run.status === "paused_for_review" ? extractHaltReason(run.notes) : null;

  // Operation summary derived from current status.
  const currentOperation = describeOperation(run.status, run.entityType);

  const status = VALID_STATUS.has(run.status) ? run.status : "created";

  return NextResponse.json(
    {
      status,
      currentOperation,
      counters,
      logs,
      haltReason,
    },
    {
      headers: {
        // Polling cadence is 5s; let proxies/CDN cache nothing.
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}

function classifyAuditLevel(action: string): "info" | "warn" | "error" {
  if (action.endsWith(".halted") || action.endsWith(".aborted")) return "error";
  if (action.endsWith(".rejected") || action.endsWith(".skipped")) return "warn";
  if (action.includes(".flagged")) return "warn";
  return "info";
}

function stringifyDetail(after: unknown): string | undefined {
  if (after == null || typeof after !== "object") return undefined;
  try {
    const s = JSON.stringify(after);
    return s.length > 500 ? `${s.slice(0, 497)}...` : s;
  } catch {
    // JSON.stringify can throw on circular refs or BigInt — we don't
    // need to fail the polling response over a malformed audit body.
    // Return undefined so the UI just doesn't show the detail.
    return undefined;
  }
}

function extractHaltReason(notes: string | null): string | null {
  if (!notes) return null;
  const lines = notes.split("\n").filter((s) => s.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed.kind === "halt" && typeof parsed.reason === "string") {
        return parsed.reason;
      }
      if (parsed.kind === "resume") {
        // Resume entry supersedes prior halt.
        return null;
      }
    } catch {
      // Non-JSON line in the notes stream — likely an old free-text
      // entry from before the kind:halt/resume contract was enforced.
      // Skip and continue scanning.
    }
  }
  return null;
}

function describeOperation(status: string, entityType: string): string | null {
  switch (status) {
    case "created":
      return `Ready — ${entityType} run created`;
    case "fetching":
      return `Fetching ${entityType} from D365`;
    case "mapping":
      return `Mapping ${entityType} records`;
    case "reviewing":
      return `Awaiting reviewer`;
    case "committing":
      return `Committing approved records`;
    case "paused_for_review":
      return `Halted — awaiting human input`;
    case "completed":
      return `Completed`;
    case "aborted":
      return `Aborted`;
    default:
      return null;
  }
}

// Defensive: log access failures via the structured logger so admin
// activity stays traceable even when downstream MCP hooks don't fire.
export async function HEAD() {
  await requireAdmin();
  logger.info("d365.status.head", {});
  return new Response(null, { status: 200 });
}
