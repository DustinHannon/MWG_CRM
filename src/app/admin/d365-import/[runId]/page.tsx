import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { requireAdmin } from "@/lib/auth-helpers";
import { RunLiveProgress } from "@/components/admin/d365-import/run-live-progress";
import {
  HaltBanner,
  type HaltReason,
} from "@/components/admin/d365-import/halt-banner";
import {
  RunStatusPill,
  BatchStatusPill,
} from "../_components/run-status-pill";
import { PullNextBatchButton } from "../_components/pull-next-batch-button";
import { RunControls } from "../_components/run-controls";
import type { RunCounters } from "@/components/admin/d365-import/use-run-realtime";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ runId: string }>;
}

export default async function RunDetailPage({ params }: PageProps) {
  await requireAdmin();
  const { runId } = await params;

  // Validate UUID shape so we 404 instead of 500 on `/admin/d365-import/foo`.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    notFound();
  }

  const [run] = await db
    .select({
      id: importRuns.id,
      entityType: importRuns.entityType,
      status: importRuns.status,
      scope: importRuns.scope,
      cursor: importRuns.cursor,
      createdAt: importRuns.createdAt,
      completedAt: importRuns.completedAt,
      notes: importRuns.notes,
      createdById: importRuns.createdById,
      createdByName: users.displayName,
    })
    .from(importRuns)
    .leftJoin(users, eq(users.id, importRuns.createdById))
    .where(eq(importRuns.id, runId))
    .limit(1);
  if (!run) notFound();

  // Aggregate batch + record counters across the run.
  const [batchAgg] = await db
    .select({
      totalBatches: count(importBatches.id),
      doneBatches: sql<number>`SUM(CASE WHEN ${importBatches.status} = 'committed' THEN 1 ELSE 0 END)`,
      totalCommitted: sql<number>`COALESCE(SUM(${importBatches.recordCountCommitted}), 0)`,
      totalApproved: sql<number>`COALESCE(SUM(${importBatches.recordCountApproved}), 0)`,
      totalRejected: sql<number>`COALESCE(SUM(${importBatches.recordCountRejected}), 0)`,
      totalFetched: sql<number>`COALESCE(SUM(${importBatches.recordCountFetched}), 0)`,
      totalConflicts: sql<number>`COALESCE(SUM(${importBatches.recordCountConflicts}), 0)`,
      totalFailed: sql<number>`COALESCE(SUM(${importBatches.recordCountFailed}), 0)`,
    })
    .from(importBatches)
    .where(eq(importBatches.runId, runId));

  // Recent batches (top 10).
  const recentBatches = await db
    .select({
      id: importBatches.id,
      batchNumber: importBatches.batchNumber,
      status: importBatches.status,
      reviewerName: users.displayName,
      reviewedAt: importBatches.reviewedAt,
      recordCountFetched: importBatches.recordCountFetched,
      recordCountApproved: importBatches.recordCountApproved,
      recordCountRejected: importBatches.recordCountRejected,
      recordCountCommitted: importBatches.recordCountCommitted,
      recordCountConflicts: importBatches.recordCountConflicts,
      recordCountFailed: importBatches.recordCountFailed,
    })
    .from(importBatches)
    .leftJoin(users, eq(users.id, importBatches.reviewerId))
    .where(eq(importBatches.runId, runId))
    .orderBy(desc(importBatches.batchNumber))
    .limit(10);

  // Pull-next-batch enable rule: disabled when run is terminal/paused
  // OR when latest batch is still pending/fetched/reviewing.
  const latestBatch = recentBatches[0];
  const latestBlocking = latestBatch
    ? ["pending", "fetched", "reviewing", "approved"].includes(latestBatch.status)
    : false;
  const pullDisabled =
    run.status === "completed" ||
    run.status === "aborted" ||
    run.status === "paused_for_review" ||
    latestBlocking;

  // Audit log: d365.import.* events scoped to this runId, plus batch
  // and record events for batches under this run.
  const childBatchIds = recentBatches.map((b) => b.id);
  const auditFilters = [ilike(auditLog.action, "d365.import.%")];
  if (childBatchIds.length > 0) {
    auditFilters.push(
      sql`(${eq(auditLog.targetId, runId)} OR ${inArray(auditLog.targetId, childBatchIds)})`,
    );
  } else {
    auditFilters.push(eq(auditLog.targetId, runId));
  }
  const recentAudit = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorName: users.displayName,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(...auditFilters))
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  // Halt-banner data: parse last JSON line from `notes` if status is
  // paused_for_review.
  const halt = parseHaltFromNotes(run.notes, run.status);

  // Sticky live-progress initial counters:
  const initialCounters: Partial<RunCounters> = {
    fetched: Number(batchAgg?.totalFetched ?? 0),
    mapped: 0,
    approved: Number(batchAgg?.totalApproved ?? 0),
    rejected: Number(batchAgg?.totalRejected ?? 0),
    committed: Number(batchAgg?.totalCommitted ?? 0),
    skipped: 0,
    failed: Number(batchAgg?.totalFailed ?? 0),
  };

  // Identify a pending batch ID to deep-link from validation_regression.
  const pendingBatchId = recentBatches.find((b) =>
    ["pending", "fetched", "reviewing"].includes(b.status),
  )?.id;

  const runName = `${run.entityType} run · ${run.createdAt.toISOString().slice(0, 10)}`;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Imports" },
          { label: "D365", href: "/admin/d365-import" },
          { label: runName },
        ]}
      />

      <header className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Admin · D365 import
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground font-display">
            {runName}
          </h1>
          <RunStatusPill status={run.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          Created by {run.createdByName ?? "—"} ·{" "}
          <UserTime value={run.createdAt.toISOString()} />
          {run.completedAt ? (
            <>
              {" · Completed "}
              <UserTime value={run.completedAt.toISOString()} />
            </>
          ) : null}
        </p>
      </header>

      <div className="mt-6">
        <RunLiveProgress
          runId={run.id}
          initialStatus={run.status}
          initialCounters={initialCounters}
          initialHaltReason={halt?.reason ?? null}
        />
      </div>

      {halt ? (
        <div className="mt-4">
          <HaltBanner
            runId={run.id}
            reason={halt.reason}
            message={halt.message}
            pendingBatchId={pendingBatchId ?? null}
            conflictCount={halt.conflictCount}
            defaultOwnerCount={halt.defaultOwnerCount}
          />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PullNextBatchButton runId={run.id} disabled={pullDisabled} />
          {pullDisabled ? (
            <p className="text-xs text-muted-foreground">
              {run.status === "paused_for_review"
                ? "Run is paused — resolve via the banner above."
                : run.status === "completed" || run.status === "aborted"
                  ? `Run is ${run.status}.`
                  : "Latest batch is still in progress — review or commit it first."}
            </p>
          ) : null}
        </div>
      )}

      <section className="mt-8 space-y-3">
        <h2 className="text-sm font-medium text-foreground">Recent batches</h2>
        <GlassCard className="overflow-hidden p-0">
          {recentBatches.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No batches yet. Click &ldquo;Pull next 100&rdquo; to fetch the
              first one.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <Th>#</Th>
                    <Th>Status</Th>
                    <Th>Records (fetched/approved/rejected/committed/conflicts/failed)</Th>
                    <Th>Reviewed by</Th>
                    <Th>Reviewed at</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentBatches.map((b) => (
                    <tr
                      key={b.id}
                      className="border-b border-border last:border-b-0 hover:bg-muted/30"
                    >
                      <Td>#{b.batchNumber}</Td>
                      <Td>
                        <BatchStatusPill status={b.status} />
                      </Td>
                      <Td className="font-mono">
                        {b.recordCountFetched}/{b.recordCountApproved}/
                        {b.recordCountRejected}/{b.recordCountCommitted}/
                        {b.recordCountConflicts}/{b.recordCountFailed}
                      </Td>
                      <Td>{b.reviewerName ?? "—"}</Td>
                      <Td>
                        {b.reviewedAt ? (
                          <UserTime value={b.reviewedAt.toISOString()} />
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td className="text-right">
                        <Link
                          href={`/admin/d365-import/${run.id}/${b.id}`}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {b.status === "committed" ? "Re-review" : "Open"}
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      </section>

      <section className="mt-8">
        <RunControls
          runId={run.id}
          status={run.status}
          canMarkComplete={
            (Number(batchAgg?.totalBatches ?? 0) > 0) &&
            !recentBatches.some((b) =>
              ["pending", "fetched", "reviewing", "approved"].includes(b.status),
            ) &&
            run.status !== "completed" &&
            run.status !== "aborted"
          }
        />
      </section>

      <section className="mt-8">
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Audit log ({recentAudit.length})
          </summary>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-muted/20">
            {recentAudit.length === 0 ? (
              <li className="p-3 text-xs text-muted-foreground">
                No audit events yet.
              </li>
            ) : (
              recentAudit.map((a) => (
                <li key={a.id} className="flex items-center gap-3 p-3 text-xs">
                  <span className="font-mono text-foreground">{a.action}</span>
                  <span className="grow text-muted-foreground">
                    {a.actorName ?? "system"}
                  </span>
                  <span className="text-muted-foreground">
                    <UserTime value={a.createdAt.toISOString()} />
                  </span>
                </li>
              ))
            )}
          </ul>
        </details>
      </section>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-2 text-left text-[11px] font-medium ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

function parseHaltFromNotes(
  notes: string | null,
  status: string,
): {
  reason: HaltReason;
  message: string | null;
  conflictCount?: number;
  defaultOwnerCount?: number;
} | null {
  if (status !== "paused_for_review" || !notes) return null;
  // Find the most recent JSON-encoded line that reads as a halt entry.
  const lines = notes.split("\n").filter((s) => s.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const kind = parsed.kind;
      if (kind === "halt" && typeof parsed.reason === "string") {
        const reason = parsed.reason as HaltReason;
        return {
          reason,
          message:
            typeof parsed.message === "string" ? parsed.message : null,
          conflictCount:
            typeof parsed.conflictCount === "number"
              ? parsed.conflictCount
              : undefined,
          defaultOwnerCount:
            typeof parsed.defaultOwnerCount === "number"
              ? parsed.defaultOwnerCount
              : undefined,
        };
      }
    } catch {
      // Non-JSON line — fall through to next.
    }
  }
  return null;
}
