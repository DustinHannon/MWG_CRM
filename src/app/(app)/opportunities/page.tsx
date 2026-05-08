import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/**
 * Phase 9C — opportunities cursor uses `<yyyy-mm-dd|null>:<uuid>`. We
 * intentionally don't reuse the leads cursor codec because
 * `expected_close_date` is a `date` (not `timestamptz`) and NULLS LAST
 * needs special handling on both encode and where-clause sides.
 */
function encodeOppCursor(date: string | null, id: string): string {
  return `${date ?? "null"}:${id}`;
}
function parseOppCursor(raw: string | undefined): { date: string | null; id: string } | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const datePart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idPart)) {
    return null;
  }
  if (datePart === "null" || datePart === "") return { date: null, id: idPart };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return { date: datePart, id: idPart };
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  // Phase 9C — cursor pagination on (expected_close_date DESC NULLS LAST, id DESC).
  // Backed by composite partial index `opportunities_close_date_id_idx`.
  const cursor = parseOppCursor(sp.cursor);
  const wheres = [eq(opportunities.isDeleted, false)];
  if (!canViewAll) wheres.push(eq(opportunities.ownerId, session.id));
  if (cursor) {
    if (cursor.date === null) {
      // Already in the NULL-block tail — only id-tiebreak remains.
      wheres.push(
        sql`(${opportunities.expectedCloseDate} IS NULL AND ${opportunities.id} < ${cursor.id})`,
      );
    } else {
      // Either an earlier non-null date OR (same date AND smaller id) OR a NULL row.
      wheres.push(
        sql`(
          ${opportunities.expectedCloseDate} < ${cursor.date}::date
          OR (${opportunities.expectedCloseDate} = ${cursor.date}::date AND ${opportunities.id} < ${cursor.id})
          OR ${opportunities.expectedCloseDate} IS NULL
        )`,
      );
    }
  }

  const rowsRaw = await db
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
    .where(and(...wheres))
    .orderBy(sql`${opportunities.expectedCloseDate} DESC NULLS LAST`, desc(opportunities.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rows = hasMore ? rowsRaw.slice(0, PAGE_SIZE) : rowsRaw;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeOppCursor(last.expectedCloseDate, last.id) : null;

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
        <div className="flex items-center gap-3">
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
          <Link
            href="/opportunities/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            + New opportunity
          </Link>
        </div>
      </div>

      <GlassCard className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No opportunities yet.{" "}
            <Link
              href="/opportunities/new"
              className="underline hover:text-foreground"
            >
              Add the first one
            </Link>{" "}
            or convert a lead.
          </p>
        ) : (
          <table className="data-table w-full text-sm">
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
                    <UserTime value={r.expectedCloseDate} mode="date" />
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

      {nextCursor || sp.cursor ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>{sp.cursor ? "Showing more results" : "Showing first 50"}</span>
          <div className="flex gap-2">
            {sp.cursor ? (
              <Link
                href="/opportunities"
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                ← Back to start
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={`/opportunities?cursor=${encodeURIComponent(nextCursor)}`}
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
