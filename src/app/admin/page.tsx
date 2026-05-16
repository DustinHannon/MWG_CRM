import { sql } from "drizzle-orm";
import { Suspense } from "react";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { leads } from "@/db/schema/leads";
import { activities } from "@/db/schema/activities";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader, StandardLoadingState } from "@/components/standard";
import { SlowEndpointsPanel } from "./server-metrics/_components/slow-endpoints";
import { OverviewSection } from "./_components/overview/overview-ui";
import { HealthStrip } from "./_components/overview/health-strip";
import { DatabaseHealth } from "./_components/overview/database-health";
import { QuickLaunch } from "./_components/overview/quick-launch";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const counts = await db.execute<{
    users: number;
    active_users: number;
    admins: number;
    leads: number;
    activities: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM ${users}) AS users,
      (SELECT count(*)::int FROM ${users} WHERE is_active = true) AS active_users,
      (SELECT count(*)::int FROM ${users} WHERE is_admin = true) AS admins,
      (SELECT count(*)::int FROM ${leads}) AS leads,
      (SELECT count(*)::int FROM ${activities}) AS activities
  `);
  const c = counts[0];

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Admin" }]} />
      <StandardPageHeader
        title="Admin overview"
        description="High-level state of the CRM. Everything here is read-only."
      />

      {/* CRM snapshot — unchanged 5 counts, fresh every load. */}
      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Users" value={c?.users ?? 0} />
        <Stat label="Active users" value={c?.active_users ?? 0} />
        <Stat label="Admins" value={c?.admins ?? 0} />
        <Stat label="Leads" value={c?.leads ?? 0} />
        <Stat label="Activities" value={c?.activities ?? 0} />
      </div>

      {/* Each widget streams independently and self-degrades; none can
          block or blank the admin landing page. No unstable_cache —
          a reload always reflects current data. */}
      <OverviewSection title="System health">
        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <HealthStrip />
        </Suspense>
      </OverviewSection>

      <OverviewSection title="Slowest endpoints (24h)">
        <Suspense fallback={<StandardLoadingState variant="table" rows={5} />}>
          <SlowEndpointsPanel range="24h" />
        </Suspense>
      </OverviewSection>

      <OverviewSection title="Database health">
        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <DatabaseHealth />
        </Suspense>
      </OverviewSection>

      <OverviewSection title="Jump to">
        <QuickLaunch />
      </OverviewSection>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-5 backdrop-blur-xl">
      <p className="text-xs uppercase tracking-wide text-muted-foreground/80">{label}</p>
      <p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
