"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type { ConnectionsPoint } from "@/lib/supabase-metrics/types";

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
 * Active vs idle Postgres connections over time, with a dashed reference
 * line at the current max_connections ceiling so saturation reads at a
 * glance against the same axis.
 */
export function ConnectionsChart({
  data,
  isLoading,
  error,
}: {
  data: ConnectionsPoint[];
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
    active: finite(p.active),
    idle: finite(p.idle),
  }));
  // The ceiling is the latest reported max; it can shift if the instance
  // is resized, so take it from the freshest point.
  const maxCeiling = finite(data[data.length - 1]?.max ?? 0);

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
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            labelFormatter={(v) => hhmm(String(v))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {maxCeiling > 0 ? (
            <ReferenceLine
              y={maxCeiling}
              stroke="var(--destructive)"
              strokeDasharray="4 4"
              label={{
                value: "max",
                position: "right",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="active"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="idle"
            stroke="var(--chart-3)"
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
