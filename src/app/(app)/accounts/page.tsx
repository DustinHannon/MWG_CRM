import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { encodeCursor, parseCursor } from "@/lib/leads";

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

  const rowsRaw = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      industry: crmAccounts.industry,
      ownerName: users.displayName,
      createdAt: crmAccounts.createdAt,
      updatedAt: crmAccounts.updatedAt,
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
