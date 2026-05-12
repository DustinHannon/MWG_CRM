"use client";

import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

/**
 * Client-side donut for the status distribution panel.
 *
 * Color mapping follows the standard chart palette in globals.css:
 * 2xx → var(--chart-1) (primary "good" channel)
 * 3xx → var(--chart-3) (neutral redirect)
 * 4xx → var(--chart-4) (client-side warning)
 * 5xx → var(--chart-2) (high-attention error channel)
 *
 * Tooltips render against the popover token so the chart reads in
 * dark mode without additional overrides.
 */

const BUCKET_COLOR: Record<string, string> = {
  "2xx": "var(--chart-1)",
  "3xx": "var(--chart-3)",
  "4xx": "var(--chart-4)",
  "5xx": "var(--chart-2)",
};

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

export interface StatusDistributionChartProps {
  data: Array<{ bucket: string; count: number }>;
}

export function StatusDistributionChart({
  data,
}: StatusDistributionChartProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="bucket"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
        >
          {data.map((row, i) => (
            <Cell
              key={`${row.bucket}-${i}`}
              fill={BUCKET_COLOR[row.bucket] ?? "var(--chart-5)"}
            />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "var(--popover-foreground)" }}
          formatter={(value, name) => [
            Number(value ?? 0).toLocaleString(),
            String(name ?? ""),
          ]}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
