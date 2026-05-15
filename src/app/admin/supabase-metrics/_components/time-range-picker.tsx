"use client";

import type { Range } from "@/lib/supabase-metrics/types";

/**
 * Controlled segmented range picker. Unlike the server-logs selector
 * this drives client state (the TanStack Query key in dashboard.tsx),
 * not a URL navigation — the dashboard polls in place so a full
 * server re-render per range change would throw away the poll cache.
 * Visual style mirrors the server-logs TimeRangeSelector for chrome
 * consistency across admin observability pages.
 */

const RANGES: ReadonlyArray<{ value: Range; label: string }> = [
  { value: "5m", label: "5m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];

export function TimeRangePicker({
  value,
  onChange,
  disabled,
}: {
  value: Range;
  onChange: (next: Range) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className={[
        "inline-flex items-center overflow-hidden rounded-md border border-border bg-muted/40 text-xs",
        disabled ? "opacity-70" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {RANGES.map((r) => {
        const active = r.value === value;
        return (
          <button
            key={r.value}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (r.value !== value) onChange(r.value);
            }}
            aria-pressed={active}
            className={[
              "px-3 py-1.5 transition",
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            ].join(" ")}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
