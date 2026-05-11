"use client";

import { ComposableMap, Geographies, Geography } from "react-simple-maps";

const TOPOJSON_URL = "/topojson/world-110m.json";

/**
 * Phase 26 §4 — world chloropleth client component.
 *
 * Renders a chloropleth based on `visitorsByCountry` keyed by ISO
 * 3166-1 alpha-2 code (`{ US: 12, JM: 1, ... }`). The world-atlas
 * TopoJSON uses M49 numeric codes as `geo.id`, so we convert
 * alpha-2 → M49 via the lookup below. Color intensity scales with
 * the country's share of the global maximum, layered over
 * `hsl(var(--primary))`.
 *
 * The lookup covers the geo-block allowlist (US/JM/PR) plus the
 * most-likely spillover countries from Vercel internal probes and
 * bypass paths. Add more entries as new countries appear in real
 * traffic — the chart simply leaves unknown alpha-2 codes blank.
 */
const ISO2_TO_M49: Record<string, string> = {
  // Geo-block allowlist (Phase 26 §6).
  US: "840",
  JM: "388",
  PR: "630",
  // Common spillover from Vercel internal probes, search crawlers,
  // and uptime monitors. Expand as needed.
  CA: "124",
  GB: "826",
  DE: "276",
  FR: "250",
  IE: "372",
  NL: "528",
  AU: "036",
  JP: "392",
  IN: "356",
  BR: "076",
  MX: "484",
  CN: "156",
  KR: "410",
  SG: "702",
};

export function WorldMapChart({
  visitorsByCountry,
}: {
  visitorsByCountry: Record<string, number>;
}) {
  const max = Math.max(0, ...Object.values(visitorsByCountry));

  // Project alpha-2 → M49 once so the per-geography callback is cheap.
  const byM49: Record<string, number> = {};
  for (const [iso2, count] of Object.entries(visitorsByCountry)) {
    const m49 = ISO2_TO_M49[iso2];
    if (m49) byM49[m49] = (byM49[m49] ?? 0) + count;
  }

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
              const m49 = String(geo.id ?? "");
              const count = byM49[m49] ?? 0;
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
