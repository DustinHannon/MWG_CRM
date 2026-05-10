import { desc } from "drizzle-orm";
import { db } from "@/db";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { UserTime } from "@/components/ui/user-time";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Suppressions read-only view.
 *
 * Sourced from SendGrid's authoritative suppression lists, mirrored by
 * the hourly /api/cron/marketing-sync-suppressions cron. Marketing
 * users can view to verify a recipient's suppression status; manual
 * removal goes through SendGrid's console (audit trail lives there).
 */
export default async function SuppressionsPage() {
  const rows = await db
    .select({
      email: marketingSuppressions.email,
      suppressionType: marketingSuppressions.suppressionType,
      reason: marketingSuppressions.reason,
      suppressedAt: marketingSuppressions.suppressedAt,
      syncedAt: marketingSuppressions.syncedAt,
    })
    .from(marketingSuppressions)
    .orderBy(desc(marketingSuppressions.suppressedAt))
    .limit(500);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Suppressions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mirror of SendGrid&apos;s suppression list. Reconciled hourly. To
          remove a suppression, use the SendGrid console.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card text-center">
          <p className="text-sm font-medium text-foreground">
            No suppressed addresses
          </p>
          <p className="text-xs text-muted-foreground">
            All recipients are receiving marketing email.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Email</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Reason</th>
                <th className="px-4 py-3 text-left font-medium">Suppressed</th>
                <th className="px-4 py-3 text-left font-medium">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.email}>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">
                    {r.email}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.suppressionType}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.reason ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.suppressedAt} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.syncedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
