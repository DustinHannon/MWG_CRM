"use client";

import { ComposableMap, Geographies, Geography } from "react-simple-maps";

const TOPOJSON_URL = "/topojson/world-110m.json";

/**
 * Phase 26 §4 — world chloropleth client component.
 *
 * Renders a chloropleth based on `visitorsByCountry` (ISO 3166-1
 * alpha-3 → visitor count). Color intensity scales with the country's
 * share of the global maximum, layered over `hsl(var(--primary))`.
 *
 * Today this component never renders because the Web Analytics drain
 * isn't configured — the server wrapper falls through to
 * StandardEmptyState. Component is kept ready so when the drain is
 * added the panel auto-populates.
 */
export function WorldMapChart({
  visitorsByCountry,
}: {
  visitorsByCountry: Record<string, number>;
}) {
  const max = Math.max(0, ...Object.values(visitorsByCountry));

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card p-2">
      <ComposableMap
        projection="geoEqualEarth"
        projectionConfig={{ scale: 150 }}
        style={{ width: "100%", height: "auto" }}
      >
        <Geographies geography={TOPOJSON_URL}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const iso = String(geo.id ?? "");
              const count = visitorsByCountry[iso] ?? 0;
              const intensity = max > 0 ? count / max : 0;
              const fill =
                count > 0
                  ? `hsl(var(--primary) / ${0.1 + intensity * 0.9})`
                  : "var(--muted)";
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={fill}
                  stroke="var(--border)"
                  strokeWidth={0.5}
                  style={{
                    default: { outline: "none" },
                    hover: {
                      outline: "none",
                      fill: "hsl(var(--primary) / 0.6)",
                    },
                    pressed: { outline: "none" },
                  }}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>
    </div>
  );
}
