import Link from "next/link";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { activities } from "@/db/schema/activities";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);

  // For non-admins without canViewAllLeads: scope to their owned leads.
  const ownerScope =
    user.isAdmin || perms.canViewAllLeads ? sql`true` : sql`owner_id = ${user.id}`;

  const stats = await db.execute<{
    my_open_leads: number;
    my_converted: number;
    activities_7d: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM ${leads} WHERE status NOT IN ('converted','lost') AND ${ownerScope}) AS my_open_leads,
      (SELECT count(*)::int FROM ${leads} WHERE status = 'converted' AND ${ownerScope}) AS my_converted,
      (SELECT count(*)::int FROM ${activities} WHERE occurred_at >= now() - interval '7 days') AS activities_7d
  `);
  const s = stats[0];

  const recent = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      status: leads.status,
      lastActivityAt: leads.lastActivityAt,
    })
    .from(leads)
    .where(user.isAdmin || perms.canViewAllLeads ? undefined : eq(leads.ownerId, user.id))
    .orderBy(sql`last_activity_at DESC NULLS LAST`)
    .limit(8);

  return (
    <div className="px-10 py-10">
      <p className="text-xs uppercase tracking-[0.3em] text-white/40">
        Welcome back
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{user.displayName}</h1>

      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="My open leads" value={s?.my_open_leads ?? 0} />
        <Stat label="Converted" value={s?.my_converted ?? 0} />
        <Stat label="Activities (7d)" value={s?.activities_7d ?? 0} />
      </div>

      <section className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/60">
          Recent leads
        </h2>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">
            No leads yet.{" "}
            {perms.canCreateLeads || user.isAdmin ? (
              <Link href="/leads/new" className="text-white/80 underline">
                Add the first one
              </Link>
            ) : (
              "Ask an admin to grant you create permissions."
            )}
            .
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {recent.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-3">
                <Link
                  href={`/leads/${l.id}`}
                  className="text-sm text-white hover:underline"
                >
                  {l.firstName} {l.lastName}
                  {l.companyName ? (
                    <span className="text-white/40"> · {l.companyName}</span>
                  ) : null}
                </Link>
                <span className="text-xs text-white/40">
                  {l.lastActivityAt
                    ? new Date(l.lastActivityAt).toLocaleDateString()
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-xl">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
