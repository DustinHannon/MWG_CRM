import { fetchSnapshot } from "@/lib/supabase-metrics/queries";
import { logger } from "@/lib/logger";
import { OverviewTile, OverviewUnavailable } from "./overview-ui";

/**
 * Latest database-host snapshot (CPU / memory / disk) from the
 * minutely metrics scrape. Read fresh per request (no unstable_cache)
 * so a reload always shows current numbers. Self-isolated: a failed
 * read degrades to an "unavailable" card, never the page.
 *
 * User-facing copy says "database" only — no vendor name.
 */
export async function DatabaseHealth() {
  let current: Awaited<ReturnType<typeof fetchSnapshot>>["current"] | null =
    null;
  try {
    const snap = await fetchSnapshot({ range: "5m" });
    current = snap.current;
  } catch (err) {
    logger.error("admin_overview.database_health_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return <OverviewUnavailable note="Database metrics unavailable right now." />;
  }

  if (!current) {
    return <OverviewUnavailable note="No database metrics scraped yet." />;
  }

  const pct = (n: number) => `${Math.round(n)}%`;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <OverviewTile
        label="CPU busy"
        value={pct(current.cpuBusyPct)}
        attention={current.cpuBusyPct >= 85}
      />
      <OverviewTile
        label="Memory used"
        value={pct(current.ramUsedPct)}
        attention={current.ramUsedPct >= 90}
      />
      <OverviewTile
        label="Disk used"
        value={pct(current.rootFsUsedPct)}
        attention={current.rootFsUsedPct >= 85}
      />
    </div>
  );
}
