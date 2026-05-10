import Link from "next/link";
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
import { isD365Configured } from "@/lib/d365";
import { D365_ENTITY_TYPES, type D365EntityType } from "@/lib/d365/types";
import { QuickPullButtons } from "@/components/admin/d365-import/quick-pull-buttons";
import { NewRunModal } from "./_components/new-run-modal";
import { RunStatusPill } from "./_components/run-status-pill";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const RUN_STATUSES = [
  "created",
  "fetching",
  "mapping",
  "reviewing",
  "committing",
  "paused_for_review",
  "completed",
  "aborted",
] as const;

interface RunListSearchParams {
  status?: string;
  entity?: string;
  cursor?: string;
}

export default async function D365ImportPage({
  searchParams,
}: {
  searchParams: Promise<RunListSearchParams>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const configured = isD365Configured();

  const filters = [];
  if (sp.status && (RUN_STATUSES as readonly string[]).includes(sp.status)) {
    filters.push(
      eq(
        importRuns.status,
        sp.status as (typeof RUN_STATUSES)[number],
      ),
    );
  }
  if (sp.entity && (D365_ENTITY_TYPES as readonly string[]).includes(sp.entity)) {
    filters.push(eq(importRuns.entityType, sp.entity));
  }
  const cursor = parseCursor(sp.cursor);
  if (cursor) {
    filters.push(
      sql`(
        ${importRuns.createdAt} < ${cursor.ts.toISOString()}::timestamptz
        OR (${importRuns.createdAt} = ${cursor.ts.toISOString()}::timestamptz AND ${importRuns.id} < ${cursor.id}::uuid)
      )`,
    );
  }
  const where = filters.length ? and(...filters) : undefined;

  const runRows = await db
    .select({
      id: importRuns.id,
      entityType: importRuns.entityType,
      status: importRuns.status,
      createdAt: importRuns.createdAt,
      createdById: importRuns.createdById,
      createdByName: users.displayName,
    })
    .from(importRuns)
    .leftJoin(users, eq(users.id, importRuns.createdById))
    .where(where)
    .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = runRows.length > PAGE_SIZE;
  const visibleRuns = hasMore ? runRows.slice(0, PAGE_SIZE) : runRows;
  const last = visibleRuns[visibleRuns.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  // Fetch per-run batch+committed counters so the table can show progress.
  const runIds = visibleRuns.map((r) => r.id);
  const batchAggBy = new Map<
    string,
    { totalBatches: number; doneBatches: number; committedRecords: number }
  >();
  if (runIds.length > 0) {
    const batchAgg = await db
      .select({
        runId: importBatches.runId,
        totalBatches: count(importBatches.id),
        doneBatches: sql<number>`SUM(CASE WHEN ${importBatches.status} = 'committed' THEN 1 ELSE 0 END)`,
        committedRecords: sql<number>`COALESCE(SUM(${importBatches.recordCountCommitted}), 0)`,
      })
      .from(importBatches)
      .where(inArray(importBatches.runId, runIds))
      .groupBy(importBatches.runId);
    for (const row of batchAgg) {
      batchAggBy.set(row.runId, {
        totalBatches: Number(row.totalBatches ?? 0),
        doneBatches: Number(row.doneBatches ?? 0),
        committedRecords: Number(row.committedRecords ?? 0),
      });
    }
  }

  // Audit accordion: most recent d365.import.* events for this admin.
  const recentAudit = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      targetId: auditLog.targetId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, user.id),
        ilike(auditLog.action, "d365.import.%"),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(15);

  const buildHref = (params: Record<string, string | null | undefined>) => {
    const out = new URLSearchParams();
    if (sp.status) out.set("status", sp.status);
    if (sp.entity) out.set("entity", sp.entity);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") out.delete(k);
      else out.set(k, v);
    }
    const qs = out.toString();
    return qs ? `/admin/d365-import?${qs}` : "/admin/d365-import";
  };

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Imports" },
          { label: "D365" },
        ]}
      />

      <header className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Admin
        </p>
        <h1 className="text-2xl font-semibold text-foreground font-display">
          D365 CRM Import
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Human-in-the-loop import from Dynamics 365 Sales. Pull batches of 100
          records at a time, review per-record, and approve before commit.
          Source <code>createdon</code> / <code>modifiedon</code> timestamps
          are preserved so historical records do not surface as new in
          recency reports.
        </p>
      </header>

      {!configured ? (
        <GlassCard className="mt-6 p-4">
          <h2 className="mb-2 text-sm font-medium text-foreground">
            Configuration required
          </h2>
          <p className="text-sm text-muted-foreground">
            D365 credentials are not yet configured. Add{" "}
            <code>D365_CLIENT_ID</code>, <code>D365_CLIENT_SECRET</code>, and
            <code>D365_BASE_URL</code> to Vercel envs (production) and
            redeploy. Quick-pull buttons below will be disabled until
            configuration is detected.
          </p>
        </GlassCard>
      ) : null}

      <section className="mt-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">
            Pull next 100 of an entity
          </h2>
          <NewRunModal />
        </div>
        <QuickPullButtons disabled={!configured} />
      </section>

      <section className="mt-8 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="text-sm font-medium text-foreground">Import runs</h2>
          <form className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Status
              <select
                name="status"
                defaultValue={sp.status ?? ""}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <option value="">Any</option>
                {RUN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Entity
              <select
                name="entity"
                defaultValue={sp.entity ?? ""}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <option value="">Any</option>
                {D365_ENTITY_TYPES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
            >
              Apply
            </button>
            {sp.status || sp.entity ? (
              <Link
                href="/admin/d365-import"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Clear
              </Link>
            ) : null}
          </form>
        </div>

        <GlassCard className="overflow-hidden p-0">
          {visibleRuns.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No import runs yet. Pick an entity above to start.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <Th>Created</Th>
                    <Th>Created by</Th>
                    <Th>Entity</Th>
                    <Th>Status</Th>
                    <Th>Batches done / total</Th>
                    <Th>Records committed</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRuns.map((r) => {
                    const agg = batchAggBy.get(r.id) ?? {
                      totalBatches: 0,
                      doneBatches: 0,
                      committedRecords: 0,
                    };
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-border last:border-b-0 hover:bg-muted/30"
                      >
                        <Td>
                          <UserTime value={r.createdAt.toISOString()} />
                        </Td>
                        <Td>{r.createdByName ?? "—"}</Td>
                        <Td>{r.entityType}</Td>
                        <Td>
                          <RunStatusPill status={r.status} />
                        </Td>
                        <Td>
                          {agg.doneBatches} / {agg.totalBatches}
                        </Td>
                        <Td>{agg.committedRecords.toLocaleString()}</Td>
                        <Td className="text-right">
                          <Link
                            href={`/admin/d365-import/${r.id}`}
                            className="text-foreground underline-offset-2 hover:underline"
                          >
                            Open
                          </Link>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>

        <div className="flex items-center justify-end gap-2 text-xs">
          {nextCursor ? (
            <Link
              href={buildHref({ cursor: nextCursor })}
              className="rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-muted/60"
            >
              Next →
            </Link>
          ) : null}
        </div>
      </section>

      <section className="mt-8">
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Recent activity (your D365 import audit log)
          </summary>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-muted/20">
            {recentAudit.length === 0 ? (
              <li className="p-3 text-xs text-muted-foreground">
                No D365 import activity yet.
              </li>
            ) : (
              recentAudit.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between p-3 text-xs"
                >
                  <span className="font-mono text-foreground">{a.action}</span>
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

function parseCursor(raw: string | undefined): { ts: Date; id: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  const ts = new Date(raw.slice(0, idx));
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, id: raw.slice(idx + 1) };
}

function encodeCursor(ts: Date, id: string): string {
  return `${ts.toISOString()}:${id}`;
}
