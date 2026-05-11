import { getTrafficTimeline } from "@/lib/observability/insights-queries";
import { StandardEmptyState } from "@/components/standard";

import { TrafficTimelineChart } from "./traffic-timeline-chart";

/**
 * Phase 26 §4 — server wrapper for the traffic timeline chart.
 *
 * Fetches 7 days of daily request counts and hands them to the client
 * component for recharts rendering. Falls back to a "drain not
 * configured" empty state on query failure.
 */
export async function TrafficTimeline() {
  let data;
  try {
    data = await getTrafficTimeline();
  } catch (err) {
    return (
      <StandardEmptyState
        variant="card"
        title="Traffic data unavailable"
        description={(err as Error).message}
      />
    );
  }
  return (
    <div className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Requests · last 7 days
      </h2>
      <TrafficTimelineChart data={data} />
    </div>
  );
}
