import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState, StandardPageHeader } from "@/components/standard";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

interface SearchParams {
  type?: string;
}

/**
 * Lists index.
 *
 * adds:
 * • Type column showing Dynamic / Static.
 * • Type filter (all | dynamic | static) via querystring.
 * • Two header action buttons (New dynamic list, New static list).
 */
export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingListsView) {
    redirect("/marketing");
  }

  const sp = await searchParams;
  const typeFilter =
    sp.type === "dynamic" || sp.type === "static_imported"
      ? sp.type
      : "all";

  const where = and(
    eq(marketingLists.isDeleted, false),
    typeFilter === "all"
      ? undefined
      : eq(marketingLists.listType, typeFilter),
  );

  const rows = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      listType: marketingLists.listType,
      memberCount: marketingLists.memberCount,
      lastRefreshedAt: marketingLists.lastRefreshedAt,
      updatedAt: marketingLists.updatedAt,
      createdByName: users.displayName,
    })
    .from(marketingLists)
    .leftJoin(users, eq(users.id, marketingLists.createdById))
    .where(where)
    .orderBy(desc(marketingLists.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsIndex()} />
      <StandardPageHeader
        title="Lists"
        description="Recipient segments for campaigns."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/marketing/lists/new?type=dynamic"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
            >
              New dynamic list
            </Link>
            <Link
              href="/marketing/lists/new/import"
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground/90 whitespace-nowrap transition hover:bg-muted"
            >
              New static list
            </Link>
          </div>
        }
      />

      <ListTypeFilter current={typeFilter} />

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No lists match"
          description={
            typeFilter === "all"
              ? "Create a dynamic list from a filter or import a static list from Excel."
              : "Switch filter to view other list types."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Members
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Last refreshed
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Created by
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id} className="transition hover:bg-accent/20">
                    <td className="px-4 py-3">
                      <Link
                        href={`/marketing/lists/${r.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <ListTypePill type={r.listType} />
                    </td>
                    <td className="px-4 py-3 text-foreground">
                      {r.memberCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.listType === "static_imported" ? (
                        <span className="text-muted-foreground/70">—</span>
                      ) : r.lastRefreshedAt ? (
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

function ListTypePill({
  type,
}: {
  type: "dynamic" | "static_imported";
}) {
  const label = type === "dynamic" ? "Dynamic" : "Static";
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function ListTypeFilter({
  current,
}: {
  current: "all" | "dynamic" | "static_imported";
}) {
  const options: Array<{
    value: "all" | "dynamic" | "static_imported";
    label: string;
  }> = [
    { value: "all", label: "All" },
    { value: "dynamic", label: "Dynamic" },
    { value: "static_imported", label: "Static" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card p-1 w-fit">
      {options.map((opt) => {
        const isActive = current === opt.value;
        const href =
          opt.value === "all"
            ? "/marketing/lists"
            : `/marketing/lists?type=${opt.value}`;
        return (
          <Link
            key={opt.value}
            href={href}
            className={
              isActive
                ? "rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                : "rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted/60"
            }
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}
