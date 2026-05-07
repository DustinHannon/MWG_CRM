import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const where = canViewAll
    ? undefined
    : eq(crmAccounts.ownerId, session.id);

  const rows = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      industry: crmAccounts.industry,
      ownerName: users.displayName,
      createdAt: crmAccounts.createdAt,
    })
    .from(crmAccounts)
    .leftJoin(users, eq(users.id, crmAccounts.ownerId))
    .where(where)
    .orderBy(desc(crmAccounts.updatedAt));

  // Touch and to satisfy lint with conditional `where`.
  void and;

  return (
    <div className="px-10 py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Accounts
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">Accounts</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Companies — created when leads are converted.
      </p>

      <GlassCard className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No accounts yet. Convert a lead to create the first one.
          </p>
        ) : (
          <table className="data-table w-full text-sm">
            <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Industry</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-glass-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/accounts/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.industry ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.ownerName ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    <UserTime value={r.createdAt} mode="date" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassCard>
    </div>
  );
}
