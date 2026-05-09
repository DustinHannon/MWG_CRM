import Link from "next/link";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { UserTime } from "@/components/ui/user-time";
import { UserAvatar } from "@/components/user-display";

export const dynamic = "force-dynamic";

const RECENT_JIT_FILTER = "jit-7d";

interface UsersListSearchParams {
  recent?: string;
}

export default async function UsersListPage({
  searchParams,
}: {
  searchParams: Promise<UsersListSearchParams>;
}) {
  const sp = await searchParams;
  const isRecentFilter = sp.recent === RECENT_JIT_FILTER;

  // Phase 15 — surface JIT telemetry. Default sort is `last_login_at desc
  // nulls last` so admins see "who's actually been around lately" up
  // top; the recent-JIT filter swaps to `jit_provisioned_at desc` and
  // narrows to users who joined in the last 7 days.
  const baseSelect = {
    id: users.id,
    username: users.username,
    email: users.email,
    displayName: users.displayName,
    isAdmin: users.isAdmin,
    isBreakglass: users.isBreakglass,
    isActive: users.isActive,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
    jitProvisioned: users.jitProvisioned,
    jitProvisionedAt: users.jitProvisionedAt,
    photoUrl: users.photoBlobUrl,
    // Owned-lead count — drives the "delete vs reassign" UX flag in 2F.4.
    leadCount: sql<number>`(SELECT count(*)::int FROM ${leads} WHERE owner_id = ${users.id})`,
  };

  const rows = isRecentFilter
    ? await db
        .select(baseSelect)
        .from(users)
        .where(
          and(
            eq(users.jitProvisioned, true),
            gt(users.jitProvisionedAt, sql`now() - interval '7 days'`),
          ),
        )
        .orderBy(desc(users.jitProvisionedAt))
    : await db
        .select(baseSelect)
        .from(users)
        // Postgres orders nulls last for DESC by default — be explicit
        // anyway so a future Drizzle change doesn't silently flip
        // freshly-created users below long-disabled ones.
        .orderBy(sql`${users.lastLoginAt} desc nulls last`, asc(users.displayName));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Users" },
        ]}
      />
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? "user" : "users"}
            {isRecentFilter ? " joined in the last 7 days" : ""}. Click a
            row to manage permissions and admin flags.
          </p>
        </div>
        <Link
          href="/admin/users/help"
          className="shrink-0 rounded-md border border-glass-border bg-input/60 px-3 py-1.5 text-xs text-foreground/80 transition hover:bg-accent/40"
        >
          Permission help
        </Link>
      </div>

      {/* Phase 15 — recently-joined filter chips. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <FilterChip href="/admin/users" active={!isRecentFilter}>
          All users
        </FilterChip>
        <FilterChip
          href={`/admin/users?recent=${RECENT_JIT_FILTER}`}
          active={isRecentFilter}
        >
          Recently joined (7d)
        </FilterChip>
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
        <table className="data-table min-w-full divide-y divide-border/60">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              {/* Phase 9C — avatar column at the front. Email column
                  stays per the audit-driven exception (admins need it). */}
              <th className="px-5 py-3 font-medium w-12"></th>
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Email</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Active</th>
              <th className="px-5 py-3 font-medium">Source</th>
              <th className="px-5 py-3 font-medium text-right">Leads</th>
              <th className="px-5 py-3 font-medium">Last login</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((u) => (
              <tr
                key={u.id}
                className="text-sm transition hover:bg-muted/40"
              >
                <td className="px-5 py-3">
                  <Link
                    href={`/admin/users/${u.id}`}
                    aria-label={u.displayName}
                  >
                    <UserAvatar
                      user={{
                        id: u.id,
                        displayName: u.displayName,
                        photoUrl: u.photoUrl,
                      }}
                      size="sm"
                    />
                  </Link>
                </td>
                <td className="px-5 py-3">
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="block font-medium text-foreground hover:underline"
                  >
                    {u.displayName}
                  </Link>
                  <span className="text-xs text-muted-foreground/80">{u.username}</span>
                </td>
                <td className="px-5 py-3 text-foreground/80">{u.email}</td>
                <td className="px-5 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {u.isAdmin ? (
                      <Pill tone="admin">Admin</Pill>
                    ) : (
                      <Pill tone="muted">User</Pill>
                    )}
                    {u.isBreakglass ? <Pill tone="warn">Breakglass</Pill> : null}
                  </div>
                </td>
                <td className="px-5 py-3">
                  {u.isActive ? (
                    <Pill tone="ok">Active</Pill>
                  ) : (
                    <Pill tone="off">Disabled</Pill>
                  )}
                </td>
                <td className="px-5 py-3 text-foreground/80">
                  <SourceLabel
                    jit={u.jitProvisioned}
                    jitAt={u.jitProvisionedAt}
                  />
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-foreground/80">
                  {u.leadCount}
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  <UserTime value={u.lastLoginAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceLabel({
  jit,
  jitAt,
}: {
  jit: boolean;
  jitAt: Date | null;
}) {
  if (!jit) {
    return <span className="text-muted-foreground">Manual</span>;
  }
  // YYYY-MM-DD in UTC — admin telemetry surface, not user-facing tz.
  const stamp = jitAt ? jitAt.toISOString().slice(0, 10) : "—";
  return <span>JIT ({stamp})</span>;
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const base =
    "inline-flex items-center rounded-full border px-3 py-1 text-xs transition";
  const palette = active
    ? "border-foreground/30 bg-foreground text-background"
    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted";
  return (
    <Link href={href} className={`${base} ${palette}`}>
      {children}
    </Link>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "ok" | "off" | "admin" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const palette = {
    ok: "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
    off: "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
    admin: "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
    warn: "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
    muted: "border-border bg-muted/40 text-muted-foreground",
  }[tone];
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${palette}`}
    >
      {children}
    </span>
  );
}
