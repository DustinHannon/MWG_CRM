"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Time range selector for /admin/server-logs.
 *
 * URL-state component. Renders a segmented button group of 1h/6h/24h/7d.
 * Selection writes `?range=...` and triggers a navigation; the server
 * component re-renders with the new range parameter and re-queries
 * Better Stack with the corresponding interval.
 *
 * `useTransition` keeps the UI responsive — the buttons stay clickable
 * while the new range loads. Buttons render a subtle "pending" tint
 * during the transition.
 */

const RANGES = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
] as const;

type RangeValue = (typeof RANGES)[number]["value"];

export interface TimeRangeSelectorProps {
  currentRange: RangeValue;
}

export function TimeRangeSelector({ currentRange }: TimeRangeSelectorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const handleSelect = (value: RangeValue) => {
    if (value === currentRange) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("range", value);
    startTransition(() => {
      router.push(`/admin/server-logs?${params.toString()}`);
    });
  };

  return (
    <div
      role="group"
      aria-label="Time range"
      className={[
        "inline-flex items-center gap-0 overflow-hidden rounded-md border border-border bg-muted/40 text-xs",
        isPending ? "opacity-70" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {RANGES.map((r) => {
        const active = r.value === currentRange;
        return (
          <button
            key={r.value}
            type="button"
            onClick={() => handleSelect(r.value)}
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
