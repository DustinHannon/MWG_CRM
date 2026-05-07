import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const where = canViewAll ? undefined : eq(opportunities.ownerId, session.id);

  const rows = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      stage: sql<string>`${opportunities.stage}::text`,
      amount: opportunities.amount,
      expectedCloseDate: opportunities.expectedCloseDate,
      accountId: opportunities.accountId,
      accountName: crmAccounts.name,
      ownerName: users.displayName,
      contactName: sql<string | null>`CASE WHEN ${contacts.id} IS NULL THEN NULL ELSE concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) END`,
    })
    .from(opportunities)
    .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .leftJoin(contacts, eq(contacts.id, opportunities.primaryContactId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(where)
    .orderBy(desc(opportunities.updatedAt));

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Opportunities
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">
            Opportunities
          </h1>
        </div>
        <div className="flex gap-1 rounded-lg border border-glass-border bg-glass-1 p-1">
          <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
            Table
          </span>
          <Link
            href="/opportunities/pipeline"
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Pipeline
          </Link>
        </div>
      </div>

      <GlassCard className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No opportunities yet. Convert a lead to create one.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Close date</th>
                <th className="px-4 py-3">Owner</th>
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
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {r.stage}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground/80">
                    {r.amount ? `$${Number(r.amount).toLocaleString()}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.accountId ? (
                      <Link
                        href={`/accounts/${r.accountId}`}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {r.accountName}
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.expectedCloseDate
                      ? new Date(r.expectedCloseDate).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.ownerName ?? "—"}
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
