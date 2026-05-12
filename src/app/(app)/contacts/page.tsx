import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { StandardPageHeader } from "@/components/standard";
import { GlassCard } from "@/components/ui/glass-card";
import { UserChip } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { encodeCursor, parseCursor } from "@/lib/leads";
import { canDeleteContact } from "@/lib/access/can-delete";
import { ContactListMobile } from "./_components/contact-list-mobile";
import { ContactRowActions } from "./_components/contact-row-actions";

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

  // cursor pagination on (updated_at DESC, id DESC).
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
      // owner id surfaced for the canonical UserChip.
      ownerId: contacts.ownerId,
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
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Contacts" }]} />
      <PageRealtime entities={["contacts"]} />
      <PagePoll entities={["contacts"]} />
      <StandardPageHeader
        kicker="Contacts"
        title="Contacts"
        fontFamily="display"
        actions={
          <>
            {session.isAdmin ? (
              <Link
                href="/contacts/archived"
                className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted md:inline-flex"
              >
                Archived
              </Link>
            ) : null}
            <Link
              href="/contacts/new"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              + New contact
            </Link>
          </>
        }
      />

      <div className="mt-6 md:hidden">
        <ContactListMobile
          rows={rows.map((r) => ({
            id: r.id,
            firstName: r.firstName,
            lastName: r.lastName,
            jobTitle: r.jobTitle ?? null,
            email: r.email ?? null,
            accountName: r.accountName ?? null,
          }))}
          emptyMessage={
            <>
              No contacts yet.{" "}
              <Link href="/contacts/new" className="underline hover:text-foreground">
                Add the first one
              </Link>
              .
            </>
          }
        />
      </div>

      <GlassCard className="mt-6 hidden overflow-hidden p-0 md:block">
        {rows.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No contacts yet.{" "}
            <Link href="/contacts/new" className="underline hover:text-foreground">
              Add the first one
            </Link>
            .
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
                <th className="w-10 px-2 py-3" aria-label="actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-glass-border">
              {rows.map((r) => (
                <tr key={r.id} className="group">
                  <td data-label="Name" className="px-4 py-2.5">
                    <Link
                      href={`/contacts/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {formatPersonName(r)}
                    </Link>
                  </td>
                  <td data-label="Title" className="px-4 py-2.5 text-muted-foreground">
                    {r.jobTitle ?? "—"}
                  </td>
                  <td data-label="Email" className="px-4 py-2.5 text-muted-foreground">
                    {r.email ?? "—"}
                  </td>
                  <td data-label="Account" className="px-4 py-2.5">
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
                  <td data-label="Owner" className="px-4 py-2.5">
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
                  <td className="w-10 px-2 py-2.5 align-middle">
                    <ContactRowActions
                      contactId={r.id}
                      contactName={formatPersonName(r)}
                      canDelete={canDeleteContact(session, { ownerId: r.ownerId })}
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
