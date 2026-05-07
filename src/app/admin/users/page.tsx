import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";

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
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-2 text-sm text-white/60">
            {rows.length} {rows.length === 1 ? "user" : "users"}. Click a row
            to manage permissions and admin flags.
          </p>
        </div>
      </div>

      <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
        <table className="min-w-full divide-y divide-white/5">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/50">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Email</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Active</th>
              <th className="px-5 py-3 font-medium">Last login</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((u) => (
              <tr
                key={u.id}
                className="text-sm transition hover:bg-white/5"
              >
                <td className="px-5 py-3">
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="block font-medium text-white hover:underline"
                  >
                    {u.displayName}
                  </Link>
                  <span className="text-xs text-white/40">{u.username}</span>
                </td>
                <td className="px-5 py-3 text-white/70">{u.email}</td>
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
                <td className="px-5 py-3 text-white/60">
                  {u.lastLoginAt
                    ? new Date(u.lastLoginAt).toLocaleString()
                    : "—"}
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
    ok: "border-emerald-300/30 bg-emerald-500/10 text-emerald-100",
    off: "border-rose-300/30 bg-rose-500/10 text-rose-100",
    admin: "border-blue-300/30 bg-blue-500/10 text-blue-100",
    warn: "border-amber-300/30 bg-amber-500/10 text-amber-100",
    muted: "border-white/15 bg-white/5 text-white/60",
  }[tone];
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${palette}`}
    >
      {children}
    </span>
  );
}
