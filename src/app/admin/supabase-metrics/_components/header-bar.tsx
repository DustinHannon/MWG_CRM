"use client";

import { RotateCw } from "lucide-react";

import type { Range, SnapshotMeta } from "@/lib/supabase-metrics/types";

import { TimeRangePicker } from "./time-range-picker";

/**
 * Control bar: last-scrape freshness + scrape-gap warning on the left,
 * range picker + manual refresh on the right. Sits directly under the
 * page header. Refresh triggers an immediate TanStack Query refetch
 * (the dashboard owns the query); it is not a server-action revalidate
 * because this page polls client-side.
 */

function formatAgo(iso: string | null): string {
  if (!iso) return "no scrapes yet";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min === 1) return "1 min ago";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
}

export function HeaderBar({
  range,
  onRangeChange,
  onRefresh,
  isFetching,
  meta,
}: {
  range: Range;
  onRangeChange: (next: Range) => void;
  onRefresh: () => void;
  isFetching: boolean;
  meta: SnapshotMeta | null;
}) {
  const lastScrapeAt = meta?.lastScrapeAt ?? null;
  const scrapeGaps = meta?.scrapeGaps ?? 0;
  const degraded = meta?.error === "transient";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Last scrape: {formatAgo(lastScrapeAt)}
        </p>
        <div className="flex items-center gap-2">
          <TimeRangePicker
            value={range}
            onChange={onRangeChange}
            disabled={isFetching}
          />
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            <RotateCw
              aria-hidden="true"
              className={[
                "h-3.5 w-3.5",
                isFetching ? "animate-spin" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              strokeWidth={1.5}
            />
            {isFetching ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {degraded ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Metrics query is degraded. Showing the last good data or an empty
          state. Retry shortly.
        </div>
      ) : scrapeGaps > 5 ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {scrapeGaps} scrape gaps in this window — the scrape cron may not
          be firing every minute.
        </div>
      ) : null}
    </div>
  );
}
