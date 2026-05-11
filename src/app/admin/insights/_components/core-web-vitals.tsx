import { StandardEmptyState } from "@/components/standard";

/**
 * Phase 26 §4 — Core Web Vitals mini-cards.
 *
 * Five metrics: LCP, FCP, CLS, INP, TTFB. None of these are present
 * in the runtime-logs drain that powers the Insights page today, so
 * each card renders the documented "drain not configured" empty
 * state. When a Speed Insights drain is added in Vercel, swap this
 * file for the live sparklines.
 */
const METRICS = ["LCP", "FCP", "CLS", "INP", "TTFB"] as const;

const EMPTY_TITLE = "Web Analytics / Speed Insights drain not configured";
const EMPTY_DESC =
  "Add a Vercel Drain for this data type in Vercel team settings → Drains → Add Drain → Better Stack destination. Until configured, this panel cannot populate.";

export function CoreWebVitals() {
  return (
    <section aria-label="Core Web Vitals" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Core Web Vitals
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {METRICS.map((m) => (
          <div key={m} className="rounded-lg border border-border bg-card p-4">
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              p75 {m}
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              —
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Drain not configured
            </p>
          </div>
        ))}
      </div>
      <StandardEmptyState
        variant="muted"
        title={EMPTY_TITLE}
        description={EMPTY_DESC}
      />
    </section>
  );
}
