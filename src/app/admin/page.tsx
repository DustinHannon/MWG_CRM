import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { leads } from "@/db/schema/leads";
import { activities } from "@/db/schema/activities";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";

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
    <div className="px-10 py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Admin" }]} />
      <h1 className="text-2xl font-semibold">Admin overview</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        High-level state of the CRM. Everything here is read-only.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Users" value={c?.users ?? 0} />
        <Stat label="Active users" value={c?.active_users ?? 0} />
        <Stat label="Admins" value={c?.admins ?? 0} />
        <Stat label="Leads" value={c?.leads ?? 0} />
        <Stat label="Activities" value={c?.activities ?? 0} />
      </div>
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
