import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { StandardPageHeader } from "@/components/standard";
import { ArchivedListMobile } from "@/components/archived/archived-list-mobile";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteLeadAction,
  restoreLeadAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived leads view. Shows soft-deleted rows with
 * Restore + permanent-Delete actions. Cron `purge-archived` removes them
 * automatically after 30 days.
 */
export default async function ArchivedLeadsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Leads", href: "/leads" },
            { label: "Archived" },
          ]}
        />
        <p className="text-sm text-muted-foreground">Admin only.</p>
      </div>
    );
  }

  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      deletedAt: leads.deletedAt,
      reason: leads.deleteReason,
      // surface the deleted-by id so the cell can render a
      // canonical UserChip; email retained only as a fallback when the
      // user record predates display-name backfill (rare).
      deletedById: leads.deletedById,
      deletedByEmail: users.email,
      deletedByName: users.displayName,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.deletedById))
    .where(eq(leads.isDeleted, true))
    .orderBy(desc(leads.deletedAt))
    .limit(200);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["leads"]} />
      <PagePoll entities={["leads"]} />
      <StandardPageHeader
        title="Archived leads"
        description="Hidden from the main views. Auto-purged 30 days after archive."
        actions={
          <Link
            href="/leads"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            ← Back to leads
          </Link>
        }
      />

      {rows.length === 0 ? (
        <GlassCard className="px-6 py-10 text-center text-sm text-muted-foreground">
          No archived leads.
        </GlassCard>
      ) : (
        <>
        {/* dense single-line list at <md, mirrors /leads. */}
        <div className="md:hidden">
          <ArchivedListMobile
            rows={rows.map((r) => ({
              id: r.id,
              title:
                [r.firstName, r.lastName].filter(Boolean).join(" ") ||
                "(Unnamed lead)",
              subtitle: r.companyName,
              deletedAt: r.deletedAt,
              deletedByName: r.deletedByName,
              deletedByEmail: r.deletedByEmail,
              reason: r.reason,
            }))}
            renderActions={(row) => (
              <>
                <form
                  action={async (fd) => {
                    "use server";
                    await restoreLeadAction(fd);
                  }}
                >
                  <input type="hidden" name="id" value={row.id} />
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
                    await hardDeleteLeadAction(fd);
                  }}
                >
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] hover:bg-destructive/30"
                  >
                    Delete permanently
                  </button>
                </form>
              </>
            )}
          />
        </div>

        <GlassCard className="hidden overflow-hidden p-0 md:block">
          <table className="data-table w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground/80">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3">By</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40">
                  <td data-label="Name" className="px-4 py-3 font-medium text-foreground">
                    {r.firstName} {r.lastName}
                  </td>
                  <td data-label="Company" className="px-4 py-3 text-foreground/80">{r.companyName ?? "—"}</td>
                  <td data-label="Archived" className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.deletedAt} mode="date" />
                  </td>
                  <td data-label="By" className="px-4 py-3">
                    {/* UserChip for the actor; falls back to
                        email then dash when neither id+name are known.
                        Hover card omitted (page caps at 200 rows). */}
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
                  <td data-label="Reason" className="px-4 py-3 text-muted-foreground">{r.reason ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <form
                        action={async (fd) => {
                          "use server";
                          await restoreLeadAction(fd);
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
                          await hardDeleteLeadAction(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] hover:bg-destructive/30"
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
        </>
      )}

      {void and}
    </div>
  );
}
