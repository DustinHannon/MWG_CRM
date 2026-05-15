"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type { CacheHitPoint } from "@/lib/supabase-metrics/types";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function hhmm(iso: string): string {
  // ISO timestamp -> HH:MM. Slice the time portion without parsing a Date.
  return iso.slice(11, 16);
}

/**
 * Buffer cache hit ratio as a percentage. The wire value is a 0..1
 * ratio; it is mapped to percent for a fixed 0-100 axis so the chart
 * does not auto-scale and hide a small dip.
 */
export function CacheHitChart({
  data,
  isLoading,
  error,
}: {
  data: CacheHitPoint[];
  isLoading?: boolean;
  error?: string | null;
}) {
  if (error) {
    return (
      <StandardEmptyState
        variant="card"
        title="Chart unavailable"
        description={error}
      />
    );
  }
  if (isLoading && data.length === 0) {
    return <div className="h-[260px] animate-pulse rounded-lg bg-muted" />;
  }
  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-sm text-muted-foreground">
        No data in this window
      </div>
    );
  }

  // Map the 0..1 ratio to a 0..100 percentage; coerce non-finite to 0.
  const safe = data.map((p) => ({
    t: p.t,
    percent: finite(p.ratio) * 100,
  }));

  return (
    <div className="h-[260px] rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={safe}
          margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => hhmm(String(v))}
          />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            labelFormatter={(v) => hhmm(String(v))}
            formatter={(value) => `${Number(value).toFixed(2)}%`}
          />
          <Line
            type="monotone"
            dataKey="percent"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
