import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { ArrowLeft, Pencil, Send } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  marketingListMembers,
  marketingLists,
} from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { StandardEmptyState } from "@/components/standard";
import type { FilterDsl } from "@/lib/security/filter-dsl";
import { DslSummary } from "../_components/dsl-summary";
import { ListDetailActions } from "../_components/list-detail-actions";
import { StaticListMembersPanel } from "../_components/static-list-members-panel";
import { listStaticListMembersForList } from "@/lib/marketing/lists/static-members";

export const dynamic = "force-dynamic";

const PAGE_SIZE_DYNAMIC = 25;
const PAGE_SIZE_STATIC = 50;

interface SearchParams {
  page?: string;
  q?: string;
  sort?: string;
  dir?: string;
}

/**
 * Phase 21 / Phase 29 §5 — Marketing list detail.
 *
 * Branches on `list_type`:
 *   • 'dynamic'          → header pill "Dynamic", DSL summary, lead-joined
 *                          member preview (existing Phase 21 behavior).
 *   • 'static_imported'  → header pill "Static", inline-editable member
 *                          table with mass-edit toolbar.
 */
export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const [list] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      description: marketingLists.description,
      filterDsl: marketingLists.filterDsl,
      listType: marketingLists.listType,
      sourceEntity: marketingLists.sourceEntity,
      memberCount: marketingLists.memberCount,
      lastRefreshedAt: marketingLists.lastRefreshedAt,
      isDeleted: marketingLists.isDeleted,
      createdAt: marketingLists.createdAt,
      updatedAt: marketingLists.updatedAt,
      createdByName: users.displayName,
    })
    .from(marketingLists)
    .leftJoin(users, eq(users.id, marketingLists.createdById))
    .where(eq(marketingLists.id, id))
    .limit(1);

  if (!list || list.isDeleted) notFound();

  const isStatic = list.listType === "static_imported";

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsDetail(list.name)} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-foreground">
              {list.name}
            </h1>
            <ListTypePill listType={list.listType} />
          </div>
          {list.description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {list.description}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">
                {list.memberCount.toLocaleString()}
              </span>{" "}
              {list.memberCount === 1 ? "recipient" : "recipients"}
            </span>
            {!isStatic ? (
              <span>
                Last refreshed:{" "}
                {list.lastRefreshedAt ? (
                  <UserTime value={list.lastRefreshedAt} />
                ) : (
                  "Never"
                )}
              </span>
            ) : null}
            {!isStatic && list.sourceEntity ? (
              <span>
                Source:{" "}
                <span className="font-medium text-foreground">
                  {labelForSourceEntity(list.sourceEntity)}
                </span>
              </span>
            ) : null}
            <span>Created by {list.createdByName ?? "—"}</span>
            <span>
              Updated <UserTime value={list.updatedAt} />
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/marketing/campaigns/new?listId=${list.id}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            <Send className="h-4 w-4" aria-hidden />
            Use in campaign
          </Link>
          {!isStatic ? (
            <Link
              href={`/marketing/lists/${list.id}/edit`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground/90 whitespace-nowrap transition hover:bg-muted"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Link>
          ) : null}
          <ListDetailActions
            listId={list.id}
            listName={list.name}
            listType={list.listType}
          />
        </div>
      </div>

      {isStatic ? (
        <StaticListDetailBody
          listId={list.id}
          page={page}
          search={sp.q ?? ""}
          sort={sp.sort ?? "added"}
          dir={sp.dir ?? "desc"}
        />
      ) : (
        <DynamicListDetailBody
          listId={list.id}
          filterDsl={list.filterDsl as FilterDsl}
          page={page}
        />
      )}
    </div>
  );
}

function ListTypePill({
  listType,
}: {
  listType: "dynamic" | "static_imported";
}) {
  const label = listType === "dynamic" ? "Dynamic" : "Static";
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function labelForSourceEntity(entity: string): string {
  switch (entity) {
    case "leads":
      return "Leads";
    case "contacts":
      return "Contacts";
    case "accounts":
      return "Accounts";
    case "opportunities":
      return "Opportunities";
    case "mixed":
      return "Mixed";
    default:
      return entity;
  }
}

async function DynamicListDetailBody({
  listId,
  filterDsl,
  page,
}: {
  listId: string;
  filterDsl: FilterDsl;
  page: number;
}) {
  const offset = (page - 1) * PAGE_SIZE_DYNAMIC;
  const memberRows = await db
    .select({
      leadId: marketingListMembers.leadId,
      memberEmail: marketingListMembers.email,
      addedAt: marketingListMembers.addedAt,
      firstName: leads.firstName,
      lastName: leads.lastName,
      status: leads.status,
      companyName: leads.companyName,
    })
    .from(marketingListMembers)
    .leftJoin(leads, eq(leads.id, marketingListMembers.leadId))
    .where(eq(marketingListMembers.listId, listId))
    .orderBy(desc(marketingListMembers.addedAt))
    .limit(PAGE_SIZE_DYNAMIC)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(marketingListMembers)
    .where(eq(marketingListMembers.listId, listId));
  const totalPages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE_DYNAMIC));

  return (
    <>
      <DslSummary dsl={filterDsl} />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Members</h2>
        {memberRows.length === 0 ? (
          <StandardEmptyState
            title="No members yet"
            description="Refresh now to evaluate the filter against current leads."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                      Email
                    </th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                      Company
                    </th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                      Added
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {memberRows.map((m) => {
                    const name = m.firstName
                      ? `${m.firstName}${m.lastName ? ` ${m.lastName}` : ""}`
                      : "—";
                    return (
                      <tr key={m.leadId} className="hover:bg-accent/20">
                        <td className="px-4 py-3">
                          <Link
                            href={`/leads/${m.leadId}`}
                            className="font-medium text-foreground hover:underline"
                          >
                            {name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {m.memberEmail}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {m.companyName ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {m.status ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <UserTime value={m.addedAt} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={`/marketing/lists/${listId}?page=${page - 1}`}
                  className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
                >
                  Previous
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link
                  href={`/marketing/lists/${listId}?page=${page + 1}`}
                  className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
                >
                  Next
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
      </div>
    </>
  );
}

async function StaticListDetailBody({
  listId,
  page,
  search,
  sort,
  dir,
}: {
  listId: string;
  page: number;
  search: string;
  sort: string;
  dir: string;
}) {
  const sortKey =
    sort === "name" || sort === "email" || sort === "added"
      ? (sort as "name" | "email" | "added")
      : "added";
  const sortDir = dir === "asc" ? "asc" : "desc";

  const result = await listStaticListMembersForList(listId, {
    page,
    pageSize: PAGE_SIZE_STATIC,
    search,
    sortKey,
    sortDir,
  });

  return (
    <StaticListMembersPanel
      listId={listId}
      initialRows={result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
      }))}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={search}
      sortKey={sortKey}
      sortDir={sortDir}
    />
  );
}
