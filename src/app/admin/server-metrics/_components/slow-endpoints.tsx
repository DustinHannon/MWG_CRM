import { Gauge } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import {
  getSlowEndpoints,
  type ServerMetricsRange,
} from "@/lib/observability/server-metrics-queries";
import {
  BetterStackNotConfiguredError,
  isBetterStackConfigured,
} from "@/lib/observability/betterstack";

/**
 * Panel 4: top 10 endpoints by p95 response time.
 *
 * Duration is parsed from each Lambda REPORT line's `message` text
 * via ClickHouse regex (see `getSlowEndpoints`). The p95 cell is
 * tinted via the destructive token at ≥1s and the warning token at
 * ≥500ms, matching the semantic-token pattern in request-volume.tsx
 * (error-rate column).
 */

const WARN_MS = 500;
const CRIT_MS = 1000;

export interface SlowEndpointsPanelProps {
  range: ServerMetricsRange;
}

export async function SlowEndpointsPanel({ range }: SlowEndpointsPanelProps) {
  if (!isBetterStackConfigured()) {
    return (
      <PanelShell>
        <StandardEmptyState
          variant="muted"
          title="Better Stack not configured"
          description="Set BETTERSTACK_* env vars and rebuild to populate this panel."
        />
      </PanelShell>
    );
  }

  let rows: Awaited<ReturnType<typeof getSlowEndpoints>>;
  try {
    rows = await getSlowEndpoints(range);
  } catch (err) {
    if (err instanceof BetterStackNotConfiguredError) {
      return (
        <PanelShell>
          <StandardEmptyState
            variant="muted"
            title="Better Stack not configured"
            description="Set BETTERSTACK_* env vars and rebuild to populate this panel."
          />
        </PanelShell>
      );
    }
    return (
      <PanelShell>
        <StandardEmptyState
          variant="muted"
          title="Query failed"
          description={(err as Error).message}
        />
      </PanelShell>
    );
  }

  if (rows.length === 0) {
    return (
      <PanelShell>
        <StandardEmptyState
          title="No endpoints meet the sample threshold"
          description="No path received ≥5 invocations in this window. Try a longer time range."
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <div className="data-table-cards overflow-hidden rounded-lg border border-border bg-card">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Path</th>
              <th className="px-4 py-2.5 text-right font-medium tabular-nums">Samples</th>
              <th className="px-4 py-2.5 text-right font-medium tabular-nums">p50</th>
              <th className="px-4 py-2.5 text-right font-medium tabular-nums">p95</th>
              <th className="px-4 py-2.5 text-right font-medium tabular-nums">Max</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, i) => {
              const samples = Number(row.samples ?? 0);
              const p50 = Number(row.p50_ms ?? 0);
              const p95 = Number(row.p95_ms ?? 0);
              const max = Number(row.max_ms ?? 0);
              const p95Tone =
                p95 >= CRIT_MS
                  ? "text-destructive"
                  : p95 >= WARN_MS
                    ? "text-warning"
                    : "text-foreground/90";
              return (
                <tr key={`${row.path ?? "null"}-${i}`}>
                  <td className="px-4 py-3" data-label="Path">
                    <div className="max-w-xl truncate font-mono text-[11px] text-foreground/90">
                      {row.path ?? "(null)"}
                    </div>
                  </td>
                  <td
                    className="px-4 py-3 text-right text-xs tabular-nums text-muted-foreground"
                    data-label="Samples"
                  >
                    {samples.toLocaleString()}
                  </td>
                  <td
                    className="px-4 py-3 text-right text-xs tabular-nums text-foreground/90"
                    data-label="p50"
                  >
                    {p50.toLocaleString()} ms
                  </td>
                  <td
                    className={[
                      "px-4 py-3 text-right text-xs tabular-nums font-medium",
                      p95Tone,
                    ].join(" ")}
                    data-label="p95"
                  >
                    {p95.toLocaleString()} ms
                  </td>
                  <td
                    className="px-4 py-3 text-right text-xs tabular-nums text-muted-foreground"
                    data-label="Max"
                  >
                    {max.toLocaleString()} ms
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <StandardPageHeader
        variant="section"
        title={
          <span className="inline-flex items-center gap-2">
            <Gauge
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            Slow endpoints
          </span>
        }
        description="Top 10 by p95 response time (≥5 samples). Duration parsed from Lambda REPORT lines; RSC query strings stripped so /dashboard and /dashboard?_rsc=... aggregate together."
      />
      {children}
    </section>
  );
}
