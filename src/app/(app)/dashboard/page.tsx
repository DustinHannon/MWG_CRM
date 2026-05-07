import Link from "next/link";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
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
 * Queries use the Drizzle query builder (not raw `sql.execute`) wherever
 * possible — the previous raw-SQL version interpolated `${activities} a`
 * for table aliasing, and Drizzle's table-object interpolation does NOT
 * mix cleanly with trailing alias tokens. The query builder produces the
 * correct schema-qualified table refs every time.
 */
export const revalidate = 60;
export const dynamic = "force-dynamic";

const OPEN_STATUSES = ["new", "contacted", "qualified"] as const;
const CLOSED_90D_STATUSES = ["converted", "lost", "unqualified"] as const;

export default async function DashboardPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllLeads;

  // Owner-scope predicate — undefined for admin / canViewAll, otherwise
  // restrict to leads owned by the actor.
  const ownerOnly = canViewAll ? undefined : eq(leads.ownerId, user.id);

  // The activities subquery uses the leads owner scope via an EXISTS
  // join. Rather than reach for raw SQL, do a cheap "lead-id list" pre-
  // fetch and pass it to inArray when scoped. For canViewAll we just
  // count all activities in the window.
  const scopedLeadIds = canViewAll
    ? null
    : (await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.ownerId, user.id))).map((r) => r.id);

  const sevenDaysAgo = sql<Date>`now() - interval '7 days'`;
  const ninetyDaysAgo = sql<Date>`now() - interval '90 days'`;

  const [
    openLeadsRow,
    newThisWeekRow,
    activitiesThisWeekRow,
    converted90Row,
    closed90Row,
    totalLeadsRow,
    statusRows,
    sourceRows,
    timelineRows,
    ownerRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(
      and(inArray(leads.status, OPEN_STATUSES), ownerOnly),
    ),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(
      and(gte(leads.createdAt, sevenDaysAgo), ownerOnly),
    ),
    canViewAll
      ? db
          .select({ count: sql<number>`count(*)::int` })
          .from(activities)
          .where(gte(activities.occurredAt, sevenDaysAgo))
      : scopedLeadIds && scopedLeadIds.length > 0
        ? db
            .select({ count: sql<number>`count(*)::int` })
            .from(activities)
            .where(
              and(
                gte(activities.occurredAt, sevenDaysAgo),
                inArray(activities.leadId, scopedLeadIds),
              ),
            )
        : Promise.resolve([{ count: 0 }]),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(
      and(
        eq(leads.status, "converted"),
        gte(leads.createdAt, ninetyDaysAgo),
        ownerOnly,
      ),
    ),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(
      and(
        inArray(leads.status, CLOSED_90D_STATUSES),
        gte(leads.createdAt, ninetyDaysAgo),
        ownerOnly,
      ),
    ),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(
      ownerOnly,
    ),
    // Status distribution.
    db
      .select({
        status: leads.status,
        count: sql<number>`count(*)::int`,
      })
      .from(leads)
      .where(ownerOnly)
      .groupBy(leads.status),
    // Source distribution.
    db
      .select({
        source: leads.source,
        count: sql<number>`count(*)::int`,
      })
      .from(leads)
      .where(ownerOnly)
      .groupBy(leads.source),
    // Last 30 days created/converted — generate_series + correlated
    // subqueries keep zero-buckets visible. The owner scope has to be
    // expressed as raw SQL here because we're not joining via the ORM.
    timelineQuery(canViewAll, user.id),
    // Top 5 owners by open lead count — admin/canViewAll only.
    canViewAll
      ? db
          .select({
            owner: users.displayName,
            open_count: sql<number>`count(${leads.id})::int`,
          })
          .from(leads)
          .innerJoin(users, eq(users.id, leads.ownerId))
          .where(inArray(leads.status, OPEN_STATUSES))
          .groupBy(users.displayName)
          .orderBy(desc(sql`count(${leads.id})`))
          .limit(5)
      : Promise.resolve(
          [] as Array<{ owner: string; open_count: number }>,
        ),
  ]);

  const totalLeads = totalLeadsRow[0]?.count ?? 0;

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

  const openLeads = openLeadsRow[0]?.count ?? 0;
  const newThisWeek = newThisWeekRow[0]?.count ?? 0;
  const activitiesWeek = activitiesThisWeekRow[0]?.count ?? 0;
  const converted90 = converted90Row[0]?.count ?? 0;
  const closed90 = closed90Row[0]?.count ?? 0;

  const conversionRate =
    closed90 > 0 ? Math.round((converted90 / closed90) * 100) : null;

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
        <Kpi label="Open leads" value={openLeads} />
        <Kpi label="New this week" value={newThisWeek} />
        <Kpi label="Activities (7d)" value={activitiesWeek} />
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
            <RecentActivity userId={user.id} />
          </ChartCard>
        )}
      </div>
    </div>
  );
}

/**
 * Generate a 30-day timeline with zero-buckets visible. Uses raw SQL
 * because Drizzle's query builder doesn't model `generate_series`.
 *
 * Owner scope is parameterised — admin/canViewAll passes a `true`
 * placeholder, otherwise a literal owner_id check tied to the user UUID.
 */
function timelineQuery(canViewAll: boolean, userId: string) {
  const ownerPredicate = canViewAll
    ? sql`true`
    : sql`owner_id = ${userId}::uuid`;

  return db.execute<
    { d: string; created: number; converted: number } & Record<string, unknown>
  >(sql`
    WITH days AS (
      SELECT (now()::date - interval '29 days' + ((n || ' day')::interval))::date AS d
      FROM generate_series(0, 29) AS n
    )
    SELECT
      to_char(days.d, 'YYYY-MM-DD') AS d,
      COALESCE((SELECT count(*)::int FROM leads
                WHERE ${ownerPredicate}
                  AND created_at::date = days.d), 0) AS created,
      COALESCE((SELECT count(*)::int FROM leads
                WHERE ${ownerPredicate}
                  AND status = 'converted'
                  AND COALESCE(converted_at::date, updated_at::date) = days.d), 0) AS converted
    FROM days
    ORDER BY days.d
  `);
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

async function RecentActivity({ userId }: { userId: string }) {
  const recent = await db
    .select({
      id: activities.id,
      leadId: activities.leadId,
      kind: activities.kind,
      subject: activities.subject,
      occurredAt: activities.occurredAt,
      leadFirst: leads.firstName,
      leadLast: leads.lastName,
    })
    .from(activities)
    .innerJoin(leads, eq(leads.id, activities.leadId))
    .where(eq(leads.ownerId, userId))
    .orderBy(desc(activities.occurredAt))
    .limit(8);

  if (recent.length === 0) {
    return <p className="text-xs text-white/40">No recent activity.</p>;
  }
  return (
    <ul className="divide-y divide-white/5 text-sm">
      {recent.map((r) => (
        <li key={r.id} className="flex items-center justify-between py-2">
          <Link
            href={`/leads/${r.leadId}`}
            className="truncate text-white hover:underline"
          >
            <span className="text-[10px] uppercase tracking-wide text-white/40">
              {r.kind}
            </span>{" "}
            <span className="text-white/70">
              {r.subject ?? "(no subject)"}
            </span>{" "}
            <span className="text-white/40">
              · {r.leadFirst} {r.leadLast}
            </span>
          </Link>
          <span className="ml-3 shrink-0 text-xs text-white/40">
            {new Date(r.occurredAt).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
