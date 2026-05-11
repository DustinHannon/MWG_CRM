import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState } from "@/components/standard";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Lists list. Read-only view of marketing_lists. The
 * filter-DSL builder UI mounts in the next pass.
 */
export default async function ListsPage() {
  const rows = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      memberCount: marketingLists.memberCount,
      lastRefreshedAt: marketingLists.lastRefreshedAt,
      updatedAt: marketingLists.updatedAt,
      createdByName: users.displayName,
    })
    .from(marketingLists)
    .leftJoin(users, eq(users.id, marketingLists.createdById))
    .where(and(eq(marketingLists.isDeleted, false)))
    .orderBy(desc(marketingLists.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsIndex()} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Lists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recipient segments derived from your CRM leads.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/marketing/lists/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            + New list
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No lists yet"
          description="Build a list to target a campaign."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Members</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                  Last refreshed
                </th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Created by</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="transition hover:bg-accent/20"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/marketing/lists/${r.id}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {r.memberCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.lastRefreshedAt ? (
                      <UserTime value={r.lastRefreshedAt} />
                    ) : (
                      "Never"
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.createdByName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
