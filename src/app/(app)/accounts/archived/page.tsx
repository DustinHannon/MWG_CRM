import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteAccountAction,
  restoreAccountAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * Phase 10 — admin-only archived accounts view. Mirrors `/leads/archived`.
 * Shows soft-deleted rows with Restore + permanent-Delete actions; cron
 * `purge-archived` (lead-only today) does not yet purge accounts, so
 * Hard delete is the only path until that's extended.
 */
export default async function ArchivedAccountsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Accounts", href: "/accounts" },
            { label: "Archived" },
          ]}
        />
        <p className="text-sm text-muted-foreground">Admin only.</p>
      </div>
    );
  }

  const rows = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      industry: crmAccounts.industry,
      deletedAt: crmAccounts.deletedAt,
      reason: crmAccounts.deleteReason,
      deletedById: crmAccounts.deletedById,
      deletedByEmail: users.email,
      deletedByName: users.displayName,
    })
    .from(crmAccounts)
    .leftJoin(users, eq(users.id, crmAccounts.deletedById))
    .where(eq(crmAccounts.isDeleted, true))
    .orderBy(desc(crmAccounts.deletedAt))
    .limit(200);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Accounts", href: "/accounts" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["accounts"]} />
      <PagePoll entities={["accounts"]} />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Archived accounts
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Hidden from the main views.
          </p>
        </div>
        <Link
          href="/accounts"
          className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
        >
          ← Back to accounts
        </Link>
      </div>

      {rows.length === 0 ? (
        <GlassCard className="px-6 py-10 text-center text-sm text-muted-foreground">
          No archived accounts.
        </GlassCard>
      ) : (
        <GlassCard className="data-table-cards overflow-hidden p-0">
          <table className="data-table w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground/80">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Industry</th>
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
                    {r.name}
                  </td>
                  <td data-label="Industry" className="px-4 py-3 text-foreground/80">{r.industry ?? "—"}</td>
                  <td data-label="Archived" className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.deletedAt} mode="date" />
                  </td>
                  <td data-label="By" className="px-4 py-3">
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
                          await restoreAccountAction(fd);
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
                          await hardDeleteAccountAction(fd);
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
      )}
    </div>
  );
}
