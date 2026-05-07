"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

/* ----------------------------------------------------------------------------
 * The dashboard renders four charts (status donut, source bar, created over
 * time line, top owners bar). Each chart is wrapped in a Recharts
 * ResponsiveContainer so the parent card controls width; height is fixed.
 *
 * Color palette comes from globals.css (--chart-1 .. --chart-5). Tooltips
 * use the popover token so they read in dark mode.
 * ------------------------------------------------------------------------- */

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

export interface StatusSlice {
  status: string;
  count: number;
}

export function StatusDonut({ data }: { data: StatusSlice[] }) {
  if (data.length === 0) {
    return <ChartEmpty>No leads yet.</ChartEmpty>;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={60}
          outerRadius={90}
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
}

export interface SourceBar {
  source: string;
  count: number;
}

export function SourceBars({ data }: { data: SourceBar[] }) {
  if (data.length === 0) return <ChartEmpty>No leads yet.</ChartEmpty>;
  const sorted = [...data].sort((a, b) => b.count - a.count);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={sorted} layout="vertical" margin={{ left: 10, right: 30 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="source"
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          width={90}
          tickFormatter={(v) => String(v).replaceAll("_", " ")}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "var(--popover-foreground)" }}
          cursor={{ fill: "var(--accent)" }}
        />
        <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface CreatedOverTimePoint {
  date: string;
  created: number;
  converted: number;
}

export function CreatedOverTime({ data }: { data: CreatedOverTimePoint[] }) {
  if (data.length === 0) return <ChartEmpty>No leads yet.</ChartEmpty>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ left: 10, right: 30, top: 10 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
        <YAxis tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "var(--popover-foreground)" }}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
        />
        <Line
          type="monotone"
          dataKey="created"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="converted"
          stroke="var(--chart-4)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface OwnerBar {
  owner: string;
  open_count: number;
}

export function OwnersBar({ data }: { data: OwnerBar[] }) {
  if (data.length === 0) return <ChartEmpty>No assigned leads.</ChartEmpty>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 30 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="owner"
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          width={140}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={{ color: "var(--popover-foreground)" }}
          cursor={{ fill: "var(--accent)" }}
        />
        <Bar dataKey="open_count" fill="var(--chart-2)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground/80">
      {children}
    </div>
  );
}
