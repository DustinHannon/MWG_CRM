"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type { NetworkPoint } from "@/lib/supabase-metrics/types";

import { formatBucketTick } from "./chart-format";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

// Coerce a possibly non-finite metric to a safe number so a single
// bad scrape point can't NaN-poison the axis scale.
function safe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

// 1024-base byte rate, 1 decimal, "/s" suffix. Used for both the
// axis ticks and the tooltip so the two never disagree.
function fmtRate(bytesPerSec: number): string {
  const v = Math.abs(bytesPerSec);
  if (v < 1024) return `${v.toFixed(1)} B/s`;
  const units = ["KB/s", "MB/s", "GB/s", "TB/s"];
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Recharts types the axis tick value and tooltip label as ReactNode,
// not string, so coerce before handing to the shared formatter.
function fmtTime(t: unknown): string {
  return formatBucketTick(String(t ?? ""));
}

/**
 * Network throughput as a mirror-axis line chart. Receive is plotted
 * positive and transmit is plotted negative so the two streams mirror
 * around the zero line, making the in/out balance readable at a glance.
 */
export function NetworkChart({
  data,
  isLoading,
  error,
}: {
  data: NetworkPoint[];
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
    return (
      <div className="min-h-[260px] animate-pulse rounded-lg bg-muted" />
    );
  }
  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-sm text-muted-foreground">
        No data in this window
      </div>
    );
  }

  const series = data.map((p) => ({
    t: p.t,
    recv: safe(p.recvBytesPerSec),
    // Negative so the transmit line mirrors below the zero axis.
    trans: -Math.abs(safe(p.transBytesPerSec)),
  }));

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height={228}>
        <LineChart
          data={series}
          margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="t"
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtTime}
          />
          <YAxis
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => fmtRate(Number(v))}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            formatter={(value, name) => [fmtRate(Number(value)), String(name)]}
            labelFormatter={fmtTime}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="recv"
            name="Recv"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="trans"
            name="Trans"
            stroke="var(--chart-2)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
