import { getTopPages } from "@/lib/observability/insights-queries";
import { StandardEmptyState } from "@/components/standard";

/**
 * top 10 paths by request count, last 24h.
 *
 * Excludes `/api/*`, `/_next/*`, `/favicon*`. Driven by the runtime
 * logs drain (vercel.proxy.path), so it has data whenever real
 * traffic has reached the app.
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
        title="No page requests in the last 24h"
        description="The runtime-logs drain hasn't recorded any non-API requests in this window."
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
