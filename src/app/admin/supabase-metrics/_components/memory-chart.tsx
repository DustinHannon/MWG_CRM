"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type { MemoryPoint } from "@/lib/supabase-metrics/types";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

const GIB = 1024 * 1024 * 1024;

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function hhmm(iso: string): string {
  // ISO timestamp -> HH:MM. Slice the time portion without parsing a Date.
  return iso.slice(11, 16);
}

// 1024-base human-readable bytes, 1 decimal.
function fmtBytes(bytes: number): string {
  const n = finite(bytes);
  if (n < 1024) return `${n.toFixed(0)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`;
}

/**
 * Memory composition over time: used/cached/buffers/free stack to the
 * physical RAM total, with `total` drawn as a dashed reference line and
 * `swapUsed` as a separate line so swap pressure reads against the same
 * byte axis.
 */
export function MemoryChart({
  data,
  isLoading,
  error,
}: {
  data: MemoryPoint[];
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

  // Coerce non-finite values to 0 so recharts never renders a gap or NaN.
  const safe = data.map((p) => ({
    t: p.t,
    used: finite(p.used),
    cached: finite(p.cached),
    buffers: finite(p.buffers),
    free: finite(p.free),
    swapUsed: finite(p.swapUsed),
    total: finite(p.total),
  }));

  return (
    <div className="h-[260px] rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
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
            tickFormatter={(v) => `${(Number(v) / GIB).toFixed(1)}G`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            labelFormatter={(v) => hhmm(String(v))}
            formatter={(value) => fmtBytes(Number(value))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area
            type="monotone"
            dataKey="used"
            stackId="mem"
            stroke="var(--chart-1)"
            fill="var(--chart-1)"
            fillOpacity={0.5}
            strokeWidth={1}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="cached"
            stackId="mem"
            stroke="var(--chart-2)"
            fill="var(--chart-2)"
            fillOpacity={0.5}
            strokeWidth={1}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="buffers"
            stackId="mem"
            stroke="var(--chart-3)"
            fill="var(--chart-3)"
            fillOpacity={0.5}
            strokeWidth={1}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="free"
            stackId="mem"
            stroke="var(--border)"
            fill="var(--border)"
            fillOpacity={0.5}
            strokeWidth={1}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="total"
            stroke="var(--foreground)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="swapUsed"
            stroke="var(--chart-5)"
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
