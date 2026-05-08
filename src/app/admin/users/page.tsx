import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { UserTime } from "@/components/ui/user-time";
import { UserAvatar } from "@/components/user-display";

export const dynamic = "force-dynamic";

export default async function UsersListPage() {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      isBreakglass: users.isBreakglass,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      // Phase 9C — surface the user's photo so the new avatar column
      // can render a real headshot when present (initials fallback otherwise).
      photoUrl: users.photoBlobUrl,
      // Owned-lead count — drives the "delete vs reassign" UX flag in 2F.4.
      leadCount: sql<number>`(SELECT count(*)::int FROM ${leads} WHERE owner_id = ${users.id})`,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  void eq;

  return (
    <div className="px-10 py-10">
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
            {rows.length} {rows.length === 1 ? "user" : "users"}. Click a row
            to manage permissions and admin flags.
          </p>
        </div>
        <Link
          href="/admin/users/help"
          className="shrink-0 rounded-md border border-glass-border bg-input/60 px-3 py-1.5 text-xs text-foreground/80 transition hover:bg-accent/40"
        >
          Permission help
        </Link>
      </div>

      <div className="mt-8 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
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

function Pill({
  tone,
  children,
}: {
  tone: "ok" | "off" | "admin" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const palette = {
    ok: "border-emerald-500/30 dark:border-emerald-300/30 bg-emerald-500/20 dark:bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
    off: "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100",
    admin: "border-blue-500/30 dark:border-blue-300/30 bg-blue-500/20 dark:bg-blue-500/15 dark:bg-blue-500/10 text-blue-700 dark:text-blue-100",
    warn: "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100",
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
