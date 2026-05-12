import { getTopReferrers } from "@/lib/observability/insights-queries";
import { StandardEmptyState } from "@/components/standard";

/**
 * top 10 referrers by request count, last 24h.
 *
 * Excludes empty/null referrers. Useful for spotting unexpected
 * inbound traffic sources.
 */
export async function TopReferrersTable() {
  let rows;
  try {
    rows = await getTopReferrers();
  } catch (err) {
    return (
      <StandardEmptyState
        variant="card"
        title="Unable to load referrers"
        description={(err as Error).message}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <StandardEmptyState
        variant="muted"
        title="No referrers in the last 24h"
        description="Either no external traffic arrived or the Referer header is being stripped upstream."
      />
    );
  }

  return (
    <section aria-label="Top referrers" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Top referrers · last 24h
      </h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Referer</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.referer}>
                <td className="truncate px-4 py-2 text-xs text-foreground">
                  {r.referer}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-foreground">
                  {r.requests.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
