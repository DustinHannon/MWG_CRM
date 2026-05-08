import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import {
  hardDeleteContactAction,
  restoreContactAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function ArchivedContactsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-10 py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Contacts", href: "/contacts" },
            { label: "Archived" },
          ]}
        />
        <p className="text-sm text-muted-foreground">Admin only.</p>
      </div>
    );
  }

  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      deletedAt: contacts.deletedAt,
      reason: contacts.deleteReason,
      deletedById: contacts.deletedById,
      deletedByEmail: users.email,
      deletedByName: users.displayName,
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.deletedById))
    .where(eq(contacts.isDeleted, true))
    .orderBy(desc(contacts.deletedAt))
    .limit(200);

  return (
    <div className="px-10 py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: "Archived" },
        ]}
      />
      <PagePoll entities={["contacts"]} />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Archived contacts
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Hidden from the main views.
          </p>
        </div>
        <Link
          href="/contacts"
          className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
        >
          ← Back to contacts
        </Link>
      </div>

      {rows.length === 0 ? (
        <GlassCard className="px-6 py-10 text-center text-sm text-muted-foreground">
          No archived contacts.
        </GlassCard>
      ) : (
        <GlassCard className="overflow-hidden p-0">
          <table className="data-table w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground/80">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3">By</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {formatPersonName(r)}
                  </td>
                  <td className="px-4 py-3 text-foreground/80">{r.email ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.deletedAt} mode="date" />
                  </td>
                  <td className="px-4 py-3">
                    {r.deletedById ? (
                      <UserChip
                        user={{
                          id: r.deletedById,
                          displayName: r.deletedByName,
                          photoUrl: null,
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">
                        {r.deletedByEmail ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{r.reason ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <form
                        action={async (fd) => {
                          "use server";
                          await restoreContactAction(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 hover:bg-muted"
                        >
                          Restore
                        </button>
                      </form>
                      <form
                        action={async (fd) => {
                          "use server";
                          await hardDeleteContactAction(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-rose-500/30 dark:border-rose-400/30 bg-rose-500/20 dark:bg-rose-500/15 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-300 hover:bg-rose-500/30"
                        >
                          Delete permanently
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
      )}
    </div>
  );
}
