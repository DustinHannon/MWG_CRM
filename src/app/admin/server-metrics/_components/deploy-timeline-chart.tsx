"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Client-side line chart for the deploy timeline.
 *
 * X-axis is the 5-minute bucket timestamp; Y-axis is the percentage
 * error rate. Vertical `ReferenceLine` markers indicate Vercel
 * deployments that completed within the visible window — the label
 * uses the short Git SHA when available.
 */

export interface DeployTimelinePoint {
  ts: number;
  label: string;
  total: number;
  errors: number;
  rate: number;
}

export interface DeployMarker {
  ts: number;
  sha: string | null;
  ref: string | null;
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

function formatTick(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface DeployTimelineChartProps {
  points: DeployTimelinePoint[];
  markers: DeployMarker[];
}

export function DeployTimelineChart({
  points,
  markers,
}: DeployTimelineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart
        data={points}
        margin={{ left: 10, right: 30, top: 10, bottom: 10 }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={formatTick}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          minTickGap={40}
        />
        <YAxis
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "var(--popover-foreground)" }}
          labelFormatter={(value) =>
            new Date(Number(value)).toLocaleString()
          }
          formatter={(value, name) => {
            const n = Number(value ?? 0);
            if (name === "Error rate") {
              return [`${n.toFixed(2)}%`, String(name)];
            }
            return [n.toLocaleString(), String(name ?? "")];
          }}
        />
        <Line
          type="monotone"
          dataKey="rate"
          stroke="var(--chart-1)"
          strokeWidth={2}
          name="Error rate"
          dot={false}
        />
        {markers.map((m, i) => (
          <ReferenceLine
            key={`${m.ts}-${i}`}
            x={m.ts}
            stroke="var(--chart-2)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: m.sha ?? "deploy",
              position: "top",
              fill: "var(--muted-foreground)",
              fontSize: 10,
            }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
