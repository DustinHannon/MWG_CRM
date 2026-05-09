import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { encodeCursor, parseCursor } from "@/lib/leads";
import { canDeleteAccount } from "@/lib/access/can-delete";
import { AccountListMobile } from "./_components/account-list-mobile";
import { AccountRowActions } from "./_components/account-row-actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  // Phase 9C — cursor pagination on (updated_at DESC, id DESC).
  // Composite partial index `crm_accounts_updated_at_id_idx` supports
  // these seeks at scale (100k+ accounts).
  const cursor = parseCursor(sp.cursor);
  const wheres = [eq(crmAccounts.isDeleted, false)];
  if (!canViewAll) wheres.push(eq(crmAccounts.ownerId, session.id));
  if (cursor) {
    wheres.push(
      sql`(
        ${crmAccounts.updatedAt} < ${cursor.ts!.toISOString()}::timestamptz
        OR (${crmAccounts.updatedAt} = ${cursor.ts!.toISOString()}::timestamptz AND ${crmAccounts.id} < ${cursor.id})
      )`,
    );
  }

  // Phase 9C (workflow) — Won deals column. Correlated subquery on
  // opportunities filtered by stage='closed_won'. The composite index
  // `opportunities_account_idx` plus the partial `is_deleted=false`
  // predicate lets Postgres index-only-scan this for typical account
  // row counts. We deliberately don't grouped-join because that would
  // either fan out the row count or require a CTE; the subquery
  // keeps the listing query plan simple.
  const wonDealsExpr = sql<number>`(
    SELECT COUNT(*)::int FROM ${opportunities}
    WHERE ${opportunities.accountId} = ${crmAccounts.id}
      AND ${opportunities.stage} = 'closed_won'
      AND ${opportunities.isDeleted} = false
  )`;

  const rowsRaw = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      industry: crmAccounts.industry,
      // Phase 9C — owner id surfaced for the canonical UserChip.
      ownerId: crmAccounts.ownerId,
      ownerName: users.displayName,
      createdAt: crmAccounts.createdAt,
      updatedAt: crmAccounts.updatedAt,
      wonDeals: wonDealsExpr,
    })
    .from(crmAccounts)
    .leftJoin(users, eq(users.id, crmAccounts.ownerId))
    .where(and(...wheres))
    .orderBy(desc(crmAccounts.updatedAt), desc(crmAccounts.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rows = hasMore ? rowsRaw.slice(0, PAGE_SIZE) : rowsRaw;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Accounts" }]} />
      <PageRealtime entities={["accounts"]} />
      <PagePoll entities={["accounts"]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Accounts
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">Accounts</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Companies — created from lead conversions or directly.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.isAdmin ? (
            <Link
              href="/accounts/archived"
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted"
            >
              Archived
            </Link>
          ) : null}
          <Link
            href="/accounts/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            + New account
          </Link>
        </div>
      </div>

      {/* Phase 12 — dense single-line list at <md, mirrors /leads. */}
      <div className="mt-6 md:hidden">
        <AccountListMobile
          rows={rows.map((r) => ({
            id: r.id,
            name: r.name,
            industry: r.industry ?? null,
            wonDeals: r.wonDeals,
            createdAt: r.createdAt,
          }))}
          emptyMessage={
            <>
              No accounts yet.{" "}
              <Link href="/accounts/new" className="underline hover:text-foreground">
                Add the first one
              </Link>{" "}
              or convert a lead.
            </>
          }
        />
      </div>

      <GlassCard className="mt-6 hidden overflow-hidden p-0 md:block">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No accounts yet.{" "}
            <Link href="/accounts/new" className="underline hover:text-foreground">
              Add the first one
            </Link>{" "}
            or convert a lead.
          </p>
        ) : (
          <table className="data-table w-full text-sm">
            <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Industry</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3 text-right">Won deals</th>
                <th className="px-4 py-3">Created</th>
                {/* Phase 10 — fixed-width trailing actions cell. */}
                <th className="w-10 px-2 py-3" aria-label="actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-glass-border">
              {rows.map((r) => (
                <tr key={r.id} className="group">
                  <td data-label="Name" className="px-4 py-2.5">
                    <Link
                      href={`/accounts/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td data-label="Industry" className="px-4 py-2.5 text-muted-foreground">
                    {r.industry ?? "—"}
                  </td>
                  <td data-label="Owner" className="px-4 py-2.5">
                    {/* Phase 9C — UserChip; hoverCard omitted on this
                        50-row table per the perf rule. */}
                    {r.ownerId ? (
                      <UserChip
                        user={{
                          id: r.ownerId,
                          displayName: r.ownerName,
                          photoUrl: null,
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td data-label="Won deals" className="px-4 py-2.5 text-right tabular-nums text-foreground/80">
                    {r.wonDeals > 0 ? r.wonDeals : "—"}
                  </td>
                  <td data-label="Created" className="px-4 py-2.5 text-muted-foreground">
                    <UserTime value={r.createdAt} mode="date" />
                  </td>
                  <td className="w-10 px-2 py-2.5 align-middle">
                    <AccountRowActions
                      accountId={r.id}
                      accountName={r.name}
                      canDelete={canDeleteAccount(session, { ownerId: r.ownerId })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassCard>

      {nextCursor || sp.cursor ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>{sp.cursor ? "Showing more results" : "Showing first 50"}</span>
          <div className="flex gap-2">
            {sp.cursor ? (
              <Link
                href="/accounts"
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                ← Back to start
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={`/accounts?cursor=${encodeURIComponent(nextCursor)}`}
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                Load more →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
