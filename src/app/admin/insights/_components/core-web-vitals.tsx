import { StandardEmptyState } from "@/components/standard";
import {
  getCoreWebVitals,
  type WebVitalMetric,
} from "@/lib/observability/insights-queries";

/**
 * Core Web Vitals mini-cards.
 *
 * Five metrics: LCP, FCP, CLS, INP, TTFB. Powered by the Speed
 * Insights drain (`vercel.speed_insights.v1` rows in Better Stack).
 * Each card shows the p75 value over the last 24h and a band pill
 * (good / needs-improvement / poor) per the web.dev Core Web
 * Vitals thresholds:
 *
 * LCP good ≤ 2500ms · needs ≤ 4000ms · poor > 4000ms
 * FCP good ≤ 1800ms · needs ≤ 3000ms · poor > 3000ms
 * CLS good ≤ 0.10 · needs ≤ 0.25 · poor > 0.25
 * INP good ≤ 200ms · needs ≤ 500ms · poor > 500ms
 * TTFB good ≤ 800ms · needs ≤ 1800ms · poor > 1800ms
 */
const METRICS: readonly WebVitalMetric[] = [
  "LCP",
  "FCP",
  "CLS",
  "INP",
  "TTFB",
] as const;

type Band = "good" | "needs-improvement" | "poor";

const THRESHOLDS: Record<WebVitalMetric, { good: number; needs: number }> = {
  LCP: { good: 2500, needs: 4000 },
  FCP: { good: 1800, needs: 3000 },
  CLS: { good: 0.1, needs: 0.25 },
  INP: { good: 200, needs: 500 },
  TTFB: { good: 800, needs: 1800 },
};

function band(metric: WebVitalMetric, p75: number): Band {
  const t = THRESHOLDS[metric];
  if (p75 <= t.good) return "good";
  if (p75 <= t.needs) return "needs-improvement";
  return "poor";
}

const BAND_TONE: Record<Band, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  "needs-improvement": "text-amber-600 dark:text-amber-400",
  poor: "text-destructive",
};

const BAND_PILL: Record<Band, string> = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "needs-improvement":
    "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  poor: "bg-destructive/10 text-destructive",
};

const BAND_LABEL: Record<Band, string> = {
  good: "Good",
  "needs-improvement": "Needs work",
  poor: "Poor",
};

/**
 * Format a metric's p75 value. CLS is unitless; the rest render in
 * `ms` until they cross 1s, then in `s` for readability.
 */
function formatValue(metric: WebVitalMetric, p75: number): string {
  if (metric === "CLS") return p75.toFixed(3);
  if (p75 < 1000) return `${Math.round(p75)} ms`;
  return `${(p75 / 1000).toFixed(2)} s`;
}

export async function CoreWebVitals() {
  let rows: Awaited<ReturnType<typeof getCoreWebVitals>>;
  try {
    rows = await getCoreWebVitals();
  } catch (err) {
    return (
      <section aria-label="Core Web Vitals" className="space-y-2">
        <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Core Web Vitals
        </h2>
        <StandardEmptyState
          variant="muted"
          title="Query failed"
          description={(err as Error).message}
        />
      </section>
    );
  }

  const byMetric = new Map(rows.map((r) => [r.metric, r]));
  const anyData = rows.length > 0;

  return (
    <section aria-label="Core Web Vitals" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Core Web Vitals
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {METRICS.map((m) => {
          const row = byMetric.get(m);
          if (!row) {
            return (
              <div
                key={m}
                className="rounded-lg border border-border bg-card p-4"
              >
                <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  p75 {m}
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-muted-foreground">
                  —
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Awaiting samples
                </p>
              </div>
            );
          }
          const b = band(m, row.p75);
          return (
            <div
              key={m}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  p75 {m}
                </p>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-[10px] font-medium",
                    BAND_PILL[b],
                  ].join(" ")}
                >
                  {BAND_LABEL[b]}
                </span>
              </div>
              <p
                className={[
                  "mt-2 text-2xl font-semibold tabular-nums",
                  BAND_TONE[b],
                ].join(" ")}
              >
                {formatValue(m, row.p75)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {row.samples.toLocaleString()} samples · 24h
              </p>
            </div>
          );
        })}
      </div>
      {!anyData ? (
        <StandardEmptyState
          variant="muted"
          title="No Speed Insights samples yet"
          description="The Speed Insights drain is configured but no metrics have been recorded in the last 24h. Browse the site and refresh."
        />
      ) : null}
    </section>
  );
}
