import { StandardEmptyState } from "@/components/standard";
import { getVisitorsByCountry } from "@/lib/observability/insights-queries";

import { WorldMapChart } from "./world-map-chart";

/**
 * Phase 26 §4 — server wrapper for the world chloropleth.
 *
 * `getVisitorsByCountry` returns `{}` until a Web Analytics drain is
 * configured, so today this always renders the documented
 * "drain not configured" empty state. The component is wired to
 * accept country data so the panel auto-populates when the drain is
 * added.
 */
export async function WorldMapPanel() {
  const visitorsByCountry = await getVisitorsByCountry();
  const hasData = Object.keys(visitorsByCountry).length > 0;

  return (
    <section aria-label="Visitors by country" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Visitors by country · last 24h
      </h2>
      {hasData ? (
        <WorldMapChart visitorsByCountry={visitorsByCountry} />
      ) : (
        <StandardEmptyState
          variant="muted"
          title="Web Analytics / Speed Insights drain not configured"
          description="Add a Vercel Drain for this data type in Vercel team settings → Drains → Add Drain → Better Stack destination. Until configured, this panel cannot populate."
        />
      )}
    </section>
  );
}
