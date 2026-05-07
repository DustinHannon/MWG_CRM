import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { formatPersonNameRow } from "@/lib/format/person-name";
import {
  CreatedOverTime,
  type CreatedOverTimePoint,
  OwnersBar,
  type OwnerBar,
  SourceBars,
  type SourceBar,
  StatusDonut,
  type StatusSlice,
} from "./charts";

/**
 * Dashboard — KPIs + 4 charts.
 *
 * Every query is plain raw SQL with literal table names (NOT Drizzle's
 * `${table}` interpolation, which behaved unpredictably in 0.45 against
 * the Supavisor pooler). Owner scope is parameterised via `${userId}`
 * for non-admins, or interpolated as the literal `true` for admins.
 *
 * revalidate=60 caps DB load; empty state when no leads exist.
 */
export const revalidate = 60;
export const dynamic = "force-dynamic";

type RowMap = Record<string, unknown>;

export default async function DashboardPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  // Owner-scope predicate as raw SQL.
  const ownerScope = canViewAll
    ? sql`true`
    : sql`owner_id = ${user.id}::uuid`;
  const ownerScopeForActivities = canViewAll
    ? sql`true`
    : sql`l.owner_id = ${user.id}::uuid`;
  const ownerScopeForRecent = canViewAll
    ? sql`true`
    : sql`l.owner_id = ${user.id}::uuid`;

  type KpiRow = {
    open_leads: number;
    new_this_week: number;
    activities_this_week: number;
    converted_90d: number;
    closed_90d: number;
    total_leads: number;
  } & RowMap;

  type StatusRow = { status: string; count: number } & RowMap;
  type SourceRow = { source: string; count: number } & RowMap;
  type TimelineRow = {
    d: string;
    created: number;
    converted: number;
  } & RowMap;
  type OwnerRow = { owner: string; open_count: number } & RowMap;

  let kpis: KpiRow[] = [];
  let statusRows: StatusRow[] = [];
  let sourceRows: SourceRow[] = [];
  let timelineRows: TimelineRow[] = [];
  let ownerRows: OwnerRow[] = [];

  try {
    [kpis, statusRows, sourceRows, timelineRows, ownerRows] =
      await Promise.all([
        db.execute<KpiRow>(sql`
          SELECT
            (SELECT count(*)::int FROM leads
             WHERE status IN ('new','contacted','qualified')
               AND ${ownerScope}) AS open_leads,
            (SELECT count(*)::int FROM leads
             WHERE created_at >= now() - interval '7 days'
               AND ${ownerScope}) AS new_this_week,
            (SELECT count(*)::int FROM activities a
             WHERE a.occurred_at >= now() - interval '7 days'
               AND EXISTS (
                 SELECT 1 FROM leads l
                 WHERE l.id = a.lead_id AND ${ownerScopeForActivities}
               )) AS activities_this_week,
            (SELECT count(*)::int FROM leads
             WHERE status = 'converted'
               AND created_at >= now() - interval '90 days'
               AND ${ownerScope}) AS converted_90d,
            (SELECT count(*)::int FROM leads
             WHERE status IN ('converted','lost','unqualified')
               AND created_at >= now() - interval '90 days'
               AND ${ownerScope}) AS closed_90d,
            (SELECT count(*)::int FROM leads WHERE ${ownerScope}) AS total_leads
        `),
        db.execute<StatusRow>(sql`
          SELECT status::text AS status, count(*)::int AS count
          FROM leads
          WHERE ${ownerScope}
          GROUP BY status
          ORDER BY count DESC
        `),
        db.execute<SourceRow>(sql`
          SELECT source::text AS source, count(*)::int AS count
          FROM leads
          WHERE ${ownerScope}
          GROUP BY source
          ORDER BY count DESC
        `),
        db.execute<TimelineRow>(sql`
          WITH days AS (
            SELECT (now()::date - interval '29 days' + ((n || ' day')::interval))::date AS d
            FROM generate_series(0, 29) AS n
          )
          SELECT
            to_char(days.d, 'YYYY-MM-DD') AS d,
            COALESCE((SELECT count(*)::int FROM leads
                      WHERE ${ownerScope}
                        AND created_at::date = days.d), 0) AS created,
            COALESCE((SELECT count(*)::int FROM leads
                      WHERE ${ownerScope}
                        AND status = 'converted'
                        AND COALESCE(converted_at::date, updated_at::date) = days.d), 0) AS converted
          FROM days
          ORDER BY days.d
        `),
        canViewAll
          ? db.execute<OwnerRow>(sql`
              SELECT u.display_name AS owner, count(l.id)::int AS open_count
              FROM leads l
              INNER JOIN users u ON u.id = l.owner_id
              WHERE l.status IN ('new','contacted','qualified')
              GROUP BY u.display_name
              ORDER BY open_count DESC
              LIMIT 5
            `)
          : Promise.resolve([] as OwnerRow[]),
      ]);
  } catch (err) {
    logger.error("dashboard.query_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // Render a minimal page instead of crashing — surfaces a friendly
    // error, lets the user navigate elsewhere.
    return (
      <div className="px-10 py-10">
        <p className="text-xs uppercase tracking-[0.3em] text-white/40">
          Welcome back
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>
        <section className="mt-10 rounded-2xl border border-rose-300/30 bg-rose-500/5 p-10 text-center">
          <h2 className="text-lg font-semibold text-rose-100">
            Dashboard temporarily unavailable
          </h2>
          <p className="mt-2 text-sm text-white/60">
            We couldn&apos;t load metrics. Try refreshing, or jump straight
            to your leads.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Link
              href="/leads"
              className="rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
            >
              Go to leads
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const k = kpis[0];
  const totalLeads = k?.total_leads ?? 0;

  if (totalLeads === 0) {
    return (
      <div className="px-10 py-10">
        <p className="text-xs uppercase tracking-[0.3em] text-white/40">
          Welcome back
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>

        <GlassCard className="mt-10 p-10 text-center">
          <h2 className="text-lg font-semibold">Nothing here yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You haven&apos;t added any leads yet. Add your first lead to start
            seeing metrics, or import a list.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            {perms.canCreateLeads || user.isAdmin ? (
              <Link
                href="/leads/new"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                + Add lead
              </Link>
            ) : null}
            {perms.canImport || user.isAdmin ? (
              <Link
                href="/leads/import"
                className="rounded-md border border-glass-border bg-glass-1 px-3 py-2 text-sm text-foreground/80 transition hover:bg-accent/40"
              >
                Import
              </Link>
            ) : null}
          </div>
        </GlassCard>
      </div>
    );
  }

  const conversionRate =
    k && k.closed_90d > 0
      ? Math.round((k.converted_90d / k.closed_90d) * 100)
      : null;

  const statusData: StatusSlice[] = statusRows.map((r) => ({
    status: r.status,
    count: r.count,
  }));
  const sourceData: SourceBar[] = sourceRows.map((r) => ({
    source: r.source,
    count: r.count,
  }));
  const timelineData: CreatedOverTimePoint[] = timelineRows.map((r) => ({
    date: r.d.slice(5),
    created: r.created,
    converted: r.converted,
  }));
  const ownersData: OwnerBar[] = ownerRows.map((r) => ({
    owner: r.owner,
    open_count: r.open_count,
  }));

  return (
    <div className="px-10 py-10">
      <p className="text-xs uppercase tracking-[0.3em] text-white/40">
        Welcome back
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>

      <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Open leads" value={k?.open_leads ?? 0} />
        <Kpi label="New this week" value={k?.new_this_week ?? 0} />
        <Kpi label="Activities (7d)" value={k?.activities_this_week ?? 0} />
        <Kpi
          label="Conversion (90d)"
          value={conversionRate === null ? "—" : `${conversionRate}%`}
        />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Leads by Status">
          <StatusDonut data={statusData} />
        </ChartCard>
        <ChartCard title="Leads by Source">
          <SourceBars data={sourceData} />
        </ChartCard>
        <ChartCard title="Leads created (last 30 days)">
          <CreatedOverTime data={timelineData} />
        </ChartCard>
        {canViewAll ? (
          <ChartCard title="Top owners by open leads">
            <OwnersBar data={ownersData} />
          </ChartCard>
        ) : (
          <ChartCard title="Recent activity">
            <RecentActivity userId={user.id} ownerScope={ownerScopeForRecent} />
          </ChartCard>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <GlassCard className="p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p>
    </GlassCard>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="p-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </GlassCard>
  );
}

async function RecentActivity({
  userId,
  ownerScope,
}: {
  userId: string;
  ownerScope: ReturnType<typeof sql>;
}) {
  void userId;
  type RecentRow = {
    id: string;
    lead_id: string;
    kind: string;
    subject: string | null;
    occurred_at: Date;
    lead_first: string;
    lead_last: string | null;
  } & RowMap;

  let recent: RecentRow[] = [];
  try {
    recent = await db.execute<RecentRow>(sql`
      SELECT a.id, a.lead_id, a.kind, a.subject, a.occurred_at,
             l.first_name AS lead_first, l.last_name AS lead_last
      FROM activities a
      INNER JOIN leads l ON l.id = a.lead_id
      WHERE ${ownerScope}
      ORDER BY a.occurred_at DESC
      LIMIT 8
    `);
  } catch (err) {
    logger.error("dashboard.recent_activity_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    recent = [];
  }

  if (recent.length === 0) {
    return <p className="text-xs text-white/40">No recent activity.</p>;
  }
  return (
    <ul className="divide-y divide-white/5 text-sm">
      {recent.map((r) => (
        <li key={r.id} className="flex items-center justify-between py-2">
          <Link
            href={`/leads/${r.lead_id}`}
            className="truncate text-white hover:underline"
          >
            <span className="text-[10px] uppercase tracking-wide text-white/40">
              {r.kind}
            </span>{" "}
            <span className="text-white/70">
              {r.subject ?? "(no subject)"}
            </span>{" "}
            <span className="text-white/40">
              ·{" "}
              {formatPersonNameRow({
                first_name: r.lead_first,
                last_name: r.lead_last,
              })}
            </span>
          </Link>
          <span className="ml-3 shrink-0 text-xs text-white/40">
            <UserTime value={r.occurred_at as unknown as Date} mode="date" />
          </span>
        </li>
      ))}
    </ul>
  );
}
