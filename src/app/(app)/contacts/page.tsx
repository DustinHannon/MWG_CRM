import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const where = canViewAll ? undefined : eq(contacts.ownerId, session.id);

  const rows = await db
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
    })
    .from(contacts)
    .leftJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(where)
    .orderBy(desc(contacts.updatedAt));

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
          <table className="w-full text-sm">
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
                      {r.firstName} {r.lastName}
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
    </div>
  );
}
