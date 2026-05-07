import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
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
 * Dashboard with KPIs + 4 charts. revalidate=60 caps DB load while keeping
 * the data feeling fresh. Empty state when no leads exist.
 *
 * Owner scope follows the same rules as the leads page: admin or
 * canViewAllLeads = entire tenant; otherwise scoped to leads owned by
 * the actor.
 */
export const revalidate = 60;
export const dynamic = "force-dynamic";

type KpiRow = {
  open_leads: number;
  new_this_week: number;
  activities_this_week: number;
  converted_90d: number;
  closed_90d: number;
  total_leads: number;
} & Record<string, unknown>;

export default async function DashboardPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllLeads;

  const ownerScope = canViewAll ? sql`true` : sql`owner_id = ${user.id}`;

  const [kpisRes, statusRes, sourceRes, timelineRes, ownersRes] =
    await Promise.all([
      // KPIs.
      db.execute<KpiRow>(sql`
        SELECT
          (SELECT count(*)::int FROM ${leads}
           WHERE status IN ('new','contacted','qualified') AND ${ownerScope}) AS open_leads,
          (SELECT count(*)::int FROM ${leads}
           WHERE created_at >= now() - interval '7 days' AND ${ownerScope}) AS new_this_week,
          (SELECT count(*)::int FROM ${activities} a
           WHERE a.occurred_at >= now() - interval '7 days'
             AND EXISTS (
               SELECT 1 FROM ${leads} l
               WHERE l.id = a.lead_id AND ${canViewAll ? sql`true` : sql`l.owner_id = ${user.id}`}
             )) AS activities_this_week,
          (SELECT count(*)::int FROM ${leads}
           WHERE status = 'converted' AND created_at >= now() - interval '90 days' AND ${ownerScope}) AS converted_90d,
          (SELECT count(*)::int FROM ${leads}
           WHERE status IN ('converted','lost','unqualified')
             AND created_at >= now() - interval '90 days' AND ${ownerScope}) AS closed_90d,
          (SELECT count(*)::int FROM ${leads} WHERE ${ownerScope}) AS total_leads
      `),
      // Status donut.
      db.execute<{ status: string; count: number } & Record<string, unknown>>(sql`
        SELECT status, count(*)::int AS count
        FROM ${leads}
        WHERE ${ownerScope}
        GROUP BY status
        ORDER BY count DESC
      `),
      // Source bars.
      db.execute<{ source: string; count: number } & Record<string, unknown>>(sql`
        SELECT source, count(*)::int AS count
        FROM ${leads}
        WHERE ${ownerScope}
        GROUP BY source
        ORDER BY count DESC
      `),
      // Created / converted over last 30 days.
      db.execute<{ d: string; created: number; converted: number } & Record<string, unknown>>(sql`
        WITH days AS (
          SELECT generate_series(
            (now()::date - interval '29 days')::date,
            now()::date,
            interval '1 day'
          )::date AS d
        )
        SELECT
          to_char(days.d, 'YYYY-MM-DD') AS d,
          coalesce((SELECT count(*)::int FROM ${leads}
                    WHERE ${ownerScope}
                      AND created_at::date = days.d), 0) AS created,
          coalesce((SELECT count(*)::int FROM ${leads}
                    WHERE ${ownerScope}
                      AND status = 'converted'
                      AND coalesce(converted_at::date, updated_at::date) = days.d), 0) AS converted
        FROM days
        ORDER BY days.d
      `),
      // Top owners — only meaningful when canViewAllLeads.
      canViewAll
        ? db.execute<{ owner: string; open_count: number } & Record<string, unknown>>(sql`
            SELECT u.display_name AS owner, count(l.id)::int AS open_count
            FROM ${leads} l
            INNER JOIN users u ON u.id = l.owner_id
            WHERE l.status IN ('new','contacted','qualified')
            GROUP BY u.display_name
            ORDER BY open_count DESC
            LIMIT 5
          `)
        : Promise.resolve([]),
    ]);

  const k = kpisRes[0];
  const totalLeads = k?.total_leads ?? 0;

  // Empty state — no leads at all in the user's scope.
  if (totalLeads === 0) {
    return (
      <div className="px-10 py-10">
        <p className="text-xs uppercase tracking-[0.3em] text-white/40">
          Welcome back
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>

        <section className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
          <h2 className="text-lg font-semibold">Nothing here yet</h2>
          <p className="mt-2 text-sm text-white/60">
            You haven&apos;t added any leads yet. Add your first lead to start
            seeing metrics, or import a list.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            {perms.canCreateLeads || user.isAdmin ? (
              <Link
                href="/leads/new"
                className="rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
              >
                + Add lead
              </Link>
            ) : null}
            {perms.canImport || user.isAdmin ? (
              <Link
                href="/leads/import"
                className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
              >
                Import
              </Link>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  // Conversion rate: converted / (converted + lost + unqualified) over 90d.
  const conversionRate =
    k && k.closed_90d > 0
      ? Math.round((k.converted_90d / k.closed_90d) * 100)
      : null;

  const statusData: StatusSlice[] = statusRes.map((r) => ({
    status: r.status,
    count: r.count,
  }));
  const sourceData: SourceBar[] = sourceRes.map((r) => ({
    source: r.source,
    count: r.count,
  }));
  const timelineData: CreatedOverTimePoint[] = timelineRes.map((r) => ({
    date: r.d.slice(5), // "MM-DD" — readable on the X axis
    created: r.created,
    converted: r.converted,
  }));
  const ownersData: OwnerBar[] = (ownersRes as { owner: string; open_count: number }[]).map(
    (r) => ({ owner: r.owner, open_count: r.open_count }),
  );

  return (
    <div className="px-10 py-10">
      <p className="text-xs uppercase tracking-[0.3em] text-white/40">
        Welcome back
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>

      {/* KPI strip */}
      <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Open leads" value={k?.open_leads ?? 0} />
        <Kpi label="New this week" value={k?.new_this_week ?? 0} />
        <Kpi label="Activities (7d)" value={k?.activities_this_week ?? 0} />
        <Kpi
          label="Conversion (90d)"
          value={conversionRate === null ? "—" : `${conversionRate}%`}
        />
      </div>

      {/* Charts */}
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
            <RecentActivity userId={user.id} canViewAll={canViewAll} />
          </ChartCard>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p>
    </div>
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
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <h2 className="text-xs font-medium uppercase tracking-wide text-white/60">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

async function RecentActivity({
  userId,
  canViewAll,
}: {
  userId: string;
  canViewAll: boolean;
}) {
  const recent = await db.execute<
    {
      id: string;
      lead_id: string;
      kind: string;
      subject: string | null;
      occurred_at: Date;
      lead_first: string;
      lead_last: string;
    } & Record<string, unknown>
  >(sql`
    SELECT a.id, a.lead_id, a.kind, a.subject, a.occurred_at,
           l.first_name AS lead_first, l.last_name AS lead_last
    FROM ${activities} a
    INNER JOIN ${leads} l ON l.id = a.lead_id
    WHERE ${canViewAll ? sql`true` : sql`l.owner_id = ${userId}`}
    ORDER BY a.occurred_at DESC
    LIMIT 8
  `);
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
              · {r.lead_first} {r.lead_last}
            </span>
          </Link>
          <span className="ml-3 shrink-0 text-xs text-white/40">
            {new Date(r.occurred_at).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
