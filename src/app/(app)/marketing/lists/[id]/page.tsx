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
import type { FilterDsl } from "@/lib/security/filter-dsl";
import { DslSummary } from "../_components/dsl-summary";
import { ListDetailActions } from "../_components/list-detail-actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

interface SearchParams {
  page?: string;
}

/**
 * Phase 21 — Marketing list detail. Header, DSL summary, member preview
 * table (paginated), and detail-page actions (refresh, edit, delete,
 * use in campaign).
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

  const offset = (page - 1) * PAGE_SIZE;
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
    .where(eq(marketingListMembers.listId, list.id))
    .orderBy(desc(marketingListMembers.addedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(marketingListMembers)
    .where(eq(marketingListMembers.listId, list.id));
  const totalPages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsDetail(list.name)} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {list.name}
          </h1>
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
            <span>
              Last refreshed:{" "}
              {list.lastRefreshedAt ? (
                <UserTime value={list.lastRefreshedAt} />
              ) : (
                "Never"
              )}
            </span>
            <span>Created by {list.createdByName ?? "—"}</span>
            <span>
              Updated <UserTime value={list.updatedAt} />
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/marketing/campaigns/new?listId=${list.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background transition hover:opacity-90"
          >
            <Send className="h-4 w-4" aria-hidden />
            Use in campaign
          </Link>
          <Link
            href={`/marketing/lists/${list.id}/edit`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground/90 transition hover:bg-muted"
          >
            <Pencil className="h-4 w-4" aria-hidden />
            Edit
          </Link>
          <ListDetailActions listId={list.id} listName={list.name} />
        </div>
      </div>

      <DslSummary dsl={list.filterDsl as FilterDsl} />

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Members</h2>
        {memberRows.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card text-center">
            <p className="text-sm font-medium text-foreground">
              No members yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Click Refresh now to evaluate the filter against current leads.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Email</th>
                  <th className="px-4 py-3 text-left font-medium">Company</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Added</th>
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
        )}

        {totalPages > 1 ? (
          <nav className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={`/marketing/lists/${list.id}?page=${page - 1}`}
                  className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
                >
                  ← Previous
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link
                  href={`/marketing/lists/${list.id}?page=${page + 1}`}
                  className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
                >
                  Next →
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
