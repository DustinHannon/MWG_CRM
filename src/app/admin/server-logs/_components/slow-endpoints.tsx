import { Gauge } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";

/**
 * Phase 26 §5 — Panel 4: slow endpoints (p95 latency by path).
 *
 * Not implemented in v1. Vercel's drain writes Lambda duration into
 * the `message` text rather than a structured field — e.g.
 *
 *   "REPORT RequestId: ... Duration: 6 ms Billed Duration: 6 ms"
 *
 * Extracting that via ClickHouse regex is possible but expensive, and
 * pairing the duration with the request path requires joining across
 * two log lines that don't share a common identifier in the fields
 * we have today. Resolving this requires an upstream change to the
 * drain (structured duration field) or a sidecar parsing job that
 * extracts durations into a dedicated table.
 *
 * Tracked as a follow-up; the panel ships as an empty state per the
 * Phase 26 brief's explicit guidance.
 */

export function SlowEndpointsPanel() {
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
        description="Top 10 by p95 response time (≥10 samples)."
      />
      <StandardEmptyState
        variant="muted"
        title="Coming soon"
        description="Per-endpoint p95 latency extraction requires parsing duration from Lambda REPORT lines. Tracked for a follow-up."
      />
    </section>
  );
}
