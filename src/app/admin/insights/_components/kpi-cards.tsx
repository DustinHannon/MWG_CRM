import { getKpiSnapshot } from "@/lib/observability/insights-queries";

/**
 * Phase 26 §4 — 6 KPI cards across the top of the Insights dashboard.
 *
 * Three cards are powered by the existing runtime-logs drain (requests,
 * page views, error rate); the other three depend on Speed Insights
 * data that we don't ingest today (LCP/INP/TTFB). Those render an
 * em-dash with a "Drain not configured" subtitle until that drain
 * is added in Vercel.
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
          value: "—",
          delta: "Drain not configured",
        },
        {
          label: "p75 INP",
          value: "—",
          delta: "Drain not configured",
        },
        {
          label: "Median TTFB",
          value: "—",
          delta: "Drain not configured",
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
