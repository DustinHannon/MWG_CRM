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
import type { DiskPoint } from "@/lib/supabase-metrics/types";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

function fmtPct(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";
}

// Accepts `unknown` because Recharts types both the axis tick value
// and the tooltip label as ReactNode, not string.
function fmtTime(t: unknown): string {
  const raw = String(t ?? "");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}


/**
 * Disk utilisation. Root and data fill percentages are independent
 * series, so plain lines (not a stacked area) are correct. The I/O
 * read-share line rides a hidden right axis as faint context — it can
 * be null on scrapes where the I/O series isn't emitted.
 */
export function DiskChart({
  data,
  isLoading,
  error,
}: {
  data: DiskPoint[];
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

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height={228}>
        <LineChart
          data={data}
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
            yAxisId="pct"
            domain={[0, 100]}
            stroke="var(--muted-foreground)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
          />
          <YAxis
            yAxisId="io"
            orientation="right"
            domain={[0, 100]}
            hide
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            formatter={(value, name) => [fmtPct(value), String(name)]}
            labelFormatter={fmtTime}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="rootUsedPct"
            name="Root disk %"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="dataUsedPct"
            name="Data disk %"
            stroke="var(--chart-3)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="io"
            type="monotone"
            dataKey="ioBalancePct"
            name="I/O read share %"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
            connectNulls={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
