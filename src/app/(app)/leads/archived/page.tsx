import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteLeadAction,
  restoreLeadAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * Phase 4G — admin-only archived leads view. Shows soft-deleted rows with
 * Restore + permanent-Delete actions. Cron `purge-archived` removes them
 * automatically after 30 days.
 */
export default async function ArchivedLeadsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-10 py-10">
        <p className="text-sm text-white/60">Admin only.</p>
      </div>
    );
  }

  const rows = await db
    .select({
      id: leads.id,
      first: leads.firstName,
      last: leads.lastName,
      company: leads.companyName,
      deletedAt: leads.deletedAt,
      reason: leads.deleteReason,
      deletedByEmail: users.email,
      deletedByName: users.displayName,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.deletedById))
    .where(eq(leads.isDeleted, true))
    .orderBy(desc(leads.deletedAt))
    .limit(200);

  return (
    <div className="px-10 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Archived leads
          </h1>
          <p className="mt-1 text-xs text-white/50">
            Hidden from the main views. Auto-purged 30 days after archive.
          </p>
        </div>
        <Link
          href="/leads"
          className="text-xs uppercase tracking-[0.2em] text-white/50 hover:text-white/80"
        >
          ← Back to leads
        </Link>
      </div>

      {rows.length === 0 ? (
        <GlassCard className="px-6 py-10 text-center text-sm text-white/50">
          No archived leads.
        </GlassCard>
      ) : (
        <GlassCard className="overflow-hidden p-0">
          <table className="data-table w-full text-sm">
            <thead className="border-b border-white/10 bg-white/5 text-left text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3">By</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03]">
                  <td className="px-4 py-3 font-medium text-white">
                    {r.first} {r.last}
                  </td>
                  <td className="px-4 py-3 text-white/70">{r.company ?? "—"}</td>
                  <td className="px-4 py-3 text-white/60">
                    <UserTime value={r.deletedAt} mode="date" />
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {r.deletedByName ?? r.deletedByEmail ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-white/60">{r.reason ?? "—"}</td>
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
                          className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
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
                          className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
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

      {void and}
    </div>
  );
}
