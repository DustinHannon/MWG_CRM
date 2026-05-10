import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
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
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsIndex()} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Lists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recipient segments derived from your CRM leads.
          </p>
        </div>
        <Link
          href="/marketing/lists/new"
          className="inline-flex h-9 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90"
        >
          New list
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card text-center">
          <p className="text-sm font-medium text-foreground">No lists yet</p>
          <p className="text-xs text-muted-foreground">
            Build a list to target a campaign.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Members</th>
                <th className="px-4 py-3 text-left font-medium">
                  Last refreshed
                </th>
                <th className="px-4 py-3 text-left font-medium">Created by</th>
                <th className="px-4 py-3 text-left font-medium">Updated</th>
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
      )}
    </div>
  );
}
