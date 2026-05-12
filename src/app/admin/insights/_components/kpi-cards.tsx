import { getKpiSnapshot } from "@/lib/observability/insights-queries";

/**
 * 6 KPI cards across the top of the Insights dashboard.
 *
 * Three cards are powered by the runtime-logs drain (requests, page
 * views, error rate); three more are powered by the Speed Insights
 * drain (p75 LCP, p75 INP, median TTFB). When the Speed Insights
 * drain has no samples in the window, the corresponding cards show
 * an em-dash with an "Awaiting data" subtitle.
 */
export async function KpiCards() {
  let snapshot: Awaited<ReturnType<typeof getKpiSnapshot>> | null = null;
  let queryError: string | null = null;
  try {
    snapshot = await getKpiSnapshot();
  } catch (err) {
    queryError = (err as Error).message;
  }

  const cards: KpiCardProps[] = snapshot
    ? [
        {
          label: "Requests · 24h",
          value: snapshot.requestsLast24h.toLocaleString(),
          delta: formatDelta(
            snapshot.requestsLast24h,
            snapshot.requestsPrior24h,
            "vs prior 24h",
          ),
        },
        {
          label: "Page views · 24h",
          value: snapshot.pageViewsLast24h.toLocaleString(),
          delta: formatDelta(
            snapshot.pageViewsLast24h,
            snapshot.pageViewsPrior24h,
            "vs prior 24h",
          ),
        },
        {
          label: "Error rate · 24h",
          value: `${(snapshot.errorRateLast24h * 100).toFixed(2)}%`,
          delta: formatRateDelta(
            snapshot.errorRateLast24h,
            snapshot.errorRatePrior24h,
          ),
        },
        {
          label: "p75 LCP",
          value: formatMs(snapshot.p75LcpMs),
          delta: formatMsDelta(snapshot.p75LcpMs, snapshot.p75LcpPriorMs),
        },
        {
          label: "p75 INP",
          value: formatMs(snapshot.p75InpMs),
          delta: formatMsDelta(snapshot.p75InpMs, snapshot.p75InpPriorMs),
        },
        {
          label: "Median TTFB",
          value: formatMs(snapshot.medianTtfbMs),
          delta: formatMsDelta(
            snapshot.medianTtfbMs,
            snapshot.medianTtfbPriorMs,
          ),
        },
      ]
    : [];

  if (queryError) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
      >
        Unable to load KPIs: {queryError}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <KpiCard key={c.label} {...c} />
      ))}
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  delta: string;
}

function KpiCard({ label, value, delta }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{delta}</p>
    </div>
  );
}

function formatDelta(current: number, prior: number, suffix: string): string {
  if (prior === 0 && current === 0) return `0 ${suffix}`;
  if (prior === 0) return `+${current.toLocaleString()} ${suffix}`;
  const diffPct = ((current - prior) / prior) * 100;
  const sign = diffPct >= 0 ? "+" : "";
  return `${sign}${diffPct.toFixed(1)}% ${suffix}`;
}

function formatRateDelta(current: number, prior: number): string {
  const diffPp = (current - prior) * 100;
  const sign = diffPp >= 0 ? "+" : "";
  return `${sign}${diffPp.toFixed(2)} pp vs prior 24h`;
}

/** Render `1234 ms` or `1.23 s` for human-friendly large values, em-dash for null. */
function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Delta string for a latency metric, with "Awaiting data" when no samples. */
function formatMsDelta(current: number | null, prior: number | null): string {
  if (current == null) return "Awaiting data";
  if (prior == null || prior === 0) return "vs prior 24h: —";
  const diffPct = ((current - prior) / prior) * 100;
  const sign = diffPct >= 0 ? "+" : "";
  return `${sign}${diffPct.toFixed(1)}% vs prior 24h`;
}
