import { StandardEmptyState } from "@/components/standard";
import { getVisitorsByCountry } from "@/lib/observability/insights-queries";

import { WorldMapChart } from "./world-map-chart";

/**
 * server wrapper for the world chloropleth.
 *
 * Driven by `getVisitorsByCountry` which aggregates Web Analytics
 * pageviews from the `vercel.analytics.v1` drain in Better Stack.
 * Falls back to an empty state when no pageviews with a country
 * header have been recorded in the last 24h.
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
          title="No visitor data yet"
          description="The Web Analytics drain is configured but no pageviews with a country header have been recorded in the last 24h. Browse the site and refresh."
        />
      )}
    </section>
  );
}
