import { desc } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState, StandardPageHeader } from "@/components/standard";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { UserTime } from "@/components/ui/user-time";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Suppressions read-only view.
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
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.suppressionsIndex()} />
      <StandardPageHeader
        title="Suppressions"
        description={
          <>
            Mirror of SendGrid&apos;s suppression list. Reconciled hourly. To
            remove a suppression, use the SendGrid console.
          </>
        }
      />

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No suppressed addresses"
          description="All recipients are receiving marketing email."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Email</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Type</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Reason</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Suppressed</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Last synced</th>
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
        </div>
      )}
    </div>
  );
}
