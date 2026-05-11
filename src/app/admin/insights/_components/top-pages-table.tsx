import { getTopPages } from "@/lib/observability/insights-queries";
import { StandardEmptyState } from "@/components/standard";

/**
 * Phase 26 §4 — top 10 paths by request count, last 24h.
 *
 * Excludes `/api/*`, `/_next/*`, `/favicon*`. Excludes runtime-logs
 * panels are unaffected; this is one of the panels that has data
 * today on the existing drain.
 */
export async function TopPagesTable() {
  let rows;
  try {
    rows = await getTopPages();
  } catch (err) {
    return (
      <StandardEmptyState
        variant="card"
        title="Unable to load top pages"
        description={(err as Error).message}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <StandardEmptyState
        variant="muted"
        title="Web Analytics / Speed Insights drain not configured"
        description="Add a Vercel Drain for this data type in Vercel team settings → Drains → Add Drain → Better Stack destination. Until configured, this panel cannot populate."
      />
    );
  }

  return (
    <section aria-label="Top pages" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Top pages · last 24h
      </h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Path</th>
              <th className="px-4 py-2 text-right font-medium">Requests</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.path}>
                <td className="truncate px-4 py-2 font-mono text-xs text-foreground">
                  {r.path}
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
