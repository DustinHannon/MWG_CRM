import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, MailIcon, MapPin, UserRound } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserAvatar } from "@/components/user-display";
import { requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import {
  getUserProfilePage,
  listOwnedLeads,
  listOwnedOpportunities,
  type UserProfilePage as UserProfilePageData,
} from "@/lib/user-profile";

export const dynamic = "force-dynamic";

interface SearchParams {
  tab?: "activity" | "leads" | "opportunities";
}

const TAB_LABEL: Record<NonNullable<SearchParams["tab"]>, string> = {
  activity: "Recent activity",
  leads: "Owned leads",
  opportunities: "Owned opportunities",
};

/**
 * Phase 9B — read-only user profile. Any signed-in user can view any
 * other user's basic profile. Sensitive fields are filtered out by
 * getUserProfilePage.
 *
 * The admin user-management page lives at /admin/users/[id] (admin-only)
 * and remains untouched by this route.
 */
export default async function UserProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const activeTab = sp.tab ?? "activity";

  const profile = await getUserProfilePage(id);
  if (!profile) notFound();
  const { user, stats, recentActivity } = profile;

  // The two list tabs only run their query when active — saves a hit on
  // the activity-tab default view (the most common case).
  const [ownedLeads, ownedOpps] = await Promise.all([
    activeTab === "leads" ? listOwnedLeads(id) : Promise.resolve([]),
    activeTab === "opportunities"
      ? listOwnedOpportunities(id)
      : Promise.resolve([]),
  ]);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[{ label: "Users" }, { label: user.displayName }]}
      />
      <Link
        href="/leads"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back
      </Link>

      {!user.isActive ? (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/15 p-3 text-xs text-amber-700 dark:text-amber-100">
          This user is deactivated and cannot sign in. Their historical
          records remain visible.
        </div>
      ) : null}

      {/* Header card */}
      <section className="mt-4 flex flex-col items-start gap-6 rounded-2xl border border-glass-border bg-glass-1 p-6 sm:flex-row">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold leading-tight">
            {user.displayName}
          </h1>
          {user.jobTitle ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {user.jobTitle}
            </p>
          ) : null}
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row icon={<MailIcon size={14} />} label="Email">
              <a
                href={`mailto:${user.email}`}
                className="hover:underline"
              >
                {user.email}
              </a>
            </Row>
            <Row icon={<Building2 size={14} />} label="Department">
              {user.department ?? "—"}
            </Row>
            <Row icon={<UserRound size={14} />} label="Manager">
              {user.managerDisplayName ? (
                user.managerEmail ? (
                  <a
                    href={`mailto:${user.managerEmail}`}
                    className="hover:underline"
                  >
                    {user.managerDisplayName}
                  </a>
                ) : (
                  user.managerDisplayName
                )
              ) : (
                "—"
              )}
            </Row>
            <Row icon={<MapPin size={14} />} label="Last login">
              {stats.lastLoginAt ? (
                <UserTime value={stats.lastLoginAt} />
              ) : (
                "Never"
              )}
            </Row>
          </dl>
        </div>
      </section>

      {/* Quick stats strip */}
      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Open leads" value={stats.openLeads} />
        <StatCard label="Open opportunities" value={stats.openOpportunities} />
        <StatCard label="Activities authored" value={stats.activitiesAuthored} />
      </section>

      {/* Tabs */}
      <nav className="mt-8 flex gap-1 border-b border-glass-border">
        {(["activity", "leads", "opportunities"] as const).map((tab) => (
          <Link
            key={tab}
            href={`/users/${id}?tab=${tab}`}
            scroll={false}
            className={`px-4 py-2 text-sm transition ${
              tab === activeTab
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABEL[tab]}
          </Link>
        ))}
      </nav>

      <section className="mt-6">
        {activeTab === "activity" ? (
          <ActivityList activity={recentActivity} />
        ) : null}
        {activeTab === "leads" ? <LeadsList rows={ownedLeads} /> : null}
        {activeTab === "opportunities" ? (
          <OpportunitiesList rows={ownedOpps} />
        ) : null}
      </section>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </dt>
        <dd className="truncate text-sm">{children}</dd>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <GlassCard className="p-4">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </GlassCard>
  );
}

function ActivityList({
  activity,
}: {
  activity: UserProfilePageData["recentActivity"];
}) {
  if (activity.length === 0) {
    return (
      <p className="rounded-lg border border-glass-border bg-glass-1 p-6 text-sm text-muted-foreground">
        No activities authored yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-glass-border rounded-lg border border-glass-border bg-glass-1">
      {activity.map((a) => {
        const parentLabel = a.leadName ?? a.accountName ?? "Record";
        const parentHref = a.leadId
          ? `/leads/${a.leadId}`
          : a.accountId
            ? `/accounts/${a.accountId}`
            : a.contactId
              ? `/contacts/${a.contactId}`
              : a.opportunityId
                ? `/opportunities/${a.opportunityId}`
                : null;
        return (
          <li key={a.id} className="flex items-start gap-4 px-4 py-3 text-sm">
            <span className="mt-0.5 inline-block min-w-[64px] rounded-full border border-border bg-muted/40 px-2 py-0.5 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
              {a.kind}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {a.subject ?? <span className="text-muted-foreground">(no subject)</span>}
              </p>
              {parentHref ? (
                <Link
                  href={parentHref}
                  className="mt-0.5 inline-block text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  on {parentLabel}
                </Link>
              ) : null}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              <UserTime value={a.occurredAt} mode="date" />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function LeadsList({
  rows,
}: {
  rows: Awaited<ReturnType<typeof listOwnedLeads>>;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-glass-border bg-glass-1 p-6 text-sm text-muted-foreground">
        No active leads owned.
      </p>
    );
  }
  return (
    <GlassCard className="overflow-hidden p-0">
      <table className="data-table w-full text-sm">
        <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Company</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Rating</th>
            <th className="px-4 py-3">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-glass-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2.5">
                <Link
                  href={`/leads/${r.id}`}
                  className="font-medium hover:underline"
                >
                  {formatPersonName(r)}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {r.companyName ?? "—"}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {r.status}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {r.rating}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                <UserTime value={r.updatedAt} mode="date" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassCard>
  );
}

function OpportunitiesList({
  rows,
}: {
  rows: Awaited<ReturnType<typeof listOwnedOpportunities>>;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-glass-border bg-glass-1 p-6 text-sm text-muted-foreground">
        No opportunities owned.
      </p>
    );
  }
  return (
    <GlassCard className="overflow-hidden p-0">
      <table className="data-table w-full text-sm">
        <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Account</th>
            <th className="px-4 py-3">Stage</th>
            <th className="px-4 py-3">Amount</th>
            <th className="px-4 py-3">Close date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-glass-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2.5">
                <Link
                  href={`/opportunities/${r.id}`}
                  className="font-medium hover:underline"
                >
                  {r.name}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                {r.accountId ? (
                  <Link
                    href={`/accounts/${r.accountId}`}
                    className="text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {r.accountName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {r.stage}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-foreground/80">
                {r.amount ? `$${Number(r.amount).toLocaleString()}` : "—"}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                <UserTime value={r.expectedCloseDate} mode="date" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassCard>
  );
}
