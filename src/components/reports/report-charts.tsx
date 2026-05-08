"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReportVisualization } from "@/db/schema/saved-reports";

/**
 * Phase 11 — small chart palette for the report runner. Mirrors the
 * dashboard's Recharts setup (CSS-variable colors, popover tooltip,
 * fixed heights inside ResponsiveContainer).
 */

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

export interface ChartDatum {
  name: string;
  value: number;
  /** Optional secondary value for charts that show two metrics. */
  value2?: number;
}

export interface ReportChartProps {
  data: ChartDatum[];
  visualization: ReportVisualization;
  primaryLabel?: string;
  secondaryLabel?: string;
}

export function ReportChart({
  data,
  visualization,
  primaryLabel = "value",
  secondaryLabel,
}: ReportChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-xs text-muted-foreground/80">
        No data for the selected definition.
      </div>
    );
  }

  switch (visualization) {
    case "bar":
      return (
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ left: 10, right: 30, top: 10 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(v) => String(v).replaceAll("_", " ")}
            />
            <YAxis tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={{ color: "var(--popover-foreground)" }}
              cursor={{ fill: "var(--accent)" }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }} />
            <Bar dataKey="value" fill="var(--chart-1)" name={primaryLabel} radius={[4, 4, 0, 0]} />
            {secondaryLabel ? (
              <Bar dataKey="value2" fill="var(--chart-2)" name={secondaryLabel} radius={[4, 4, 0, 0]} />
            ) : null}
          </BarChart>
        </ResponsiveContainer>
      );

    case "line":
      return (
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data} margin={{ left: 10, right: 30, top: 10 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              tickFormatter={(v) => String(v).replaceAll("_", " ")}
            />
            <YAxis tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={{ color: "var(--popover-foreground)" }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }} />
            <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} name={primaryLabel} dot={false} />
            {secondaryLabel ? (
              <Line type="monotone" dataKey="value2" stroke="var(--chart-2)" strokeWidth={2} name={secondaryLabel} dot={false} />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      );

    case "pie":
      return (
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={70}
              outerRadius={110}
              paddingAngle={2}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={{ color: "var(--popover-foreground)" }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
              formatter={(v) => String(v).replaceAll("_", " ")}
            />
          </PieChart>
        </ResponsiveContainer>
      );

    case "funnel": {
      // Funnel expects rows sorted descending. Cap to 8 stages so the
      // chart stays readable.
      const sorted = [...data].sort((a, b) => b.value - a.value).slice(0, 8);
      return (
        <ResponsiveContainer width="100%" height={360}>
          <FunnelChart>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              itemStyle={{ color: "var(--popover-foreground)" }}
            />
            <Funnel
              dataKey="value"
              nameKey="name"
              data={sorted}
              isAnimationActive
            >
              {sorted.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
              <LabelList
                position="right"
                fill="var(--foreground)"
                stroke="none"
                dataKey="name"
                formatter={(v: unknown) => String(v).replaceAll("_", " ")}
              />
            </Funnel>
          </FunnelChart>
        </ResponsiveContainer>
      );
    }

    case "kpi": {
      // For KPI we collapse to a single big number — sum of value across
      // groups. Grouped KPIs render as a small grid of tiles.
      if (data.length === 1) {
        return (
          <div className="flex h-[200px] items-center justify-center">
            <div className="text-center">
              <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                {data[0].name}
              </p>
              <p className="mt-3 text-5xl font-semibold tabular-nums">
                {formatNumber(data[0].value)}
              </p>
            </div>
          </div>
        );
      }
      return (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {data.map((d, i) => (
            <div
              key={`${d.name}-${i}`}
              className="rounded-lg border border-border bg-muted/20 p-4"
            >
              <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">
                {String(d.name).replaceAll("_", " ")}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {formatNumber(d.value)}
              </p>
            </div>
          ))}
        </div>
      );
    }

    default:
      return null;
  }
}

function formatNumber(n: number): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}
