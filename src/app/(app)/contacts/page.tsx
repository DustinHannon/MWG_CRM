import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { encodeCursor, parseCursor } from "@/lib/leads";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  // Phase 9C — cursor pagination on (updated_at DESC, id DESC).
  // Backed by composite partial index `contacts_updated_at_id_idx`.
  const cursor = parseCursor(sp.cursor);
  const wheres = [eq(contacts.isDeleted, false)];
  if (!canViewAll) wheres.push(eq(contacts.ownerId, session.id));
  if (cursor) {
    wheres.push(
      sql`(
        ${contacts.updatedAt} < ${cursor.ts!.toISOString()}::timestamptz
        OR (${contacts.updatedAt} = ${cursor.ts!.toISOString()}::timestamptz AND ${contacts.id} < ${cursor.id})
      )`,
    );
  }

  const rowsRaw = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      jobTitle: contacts.jobTitle,
      accountId: contacts.accountId,
      accountName: crmAccounts.name,
      ownerName: users.displayName,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .leftJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(...wheres))
    .orderBy(desc(contacts.updatedAt), desc(contacts.id))
    .limit(PAGE_SIZE + 1);

  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rows = hasMore ? rowsRaw.slice(0, PAGE_SIZE) : rowsRaw;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  return (
    <div className="px-10 py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Contacts
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">Contacts</h1>

      <GlassCard className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No contacts yet.
          </p>
        ) : (
          <table className="data-table w-full text-sm">
            <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Owner</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-glass-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/contacts/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {formatPersonName(r)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.jobTitle ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {r.email ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.accountId ? (
                      <Link
                        href={`/accounts/${r.accountId}`}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {r.accountName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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
                href="/contacts"
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                ← Back to start
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={`/contacts?cursor=${encodeURIComponent(nextCursor)}`}
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
