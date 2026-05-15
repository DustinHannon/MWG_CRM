"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type { CpuPoint } from "@/lib/supabase-metrics/types";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

// Only --chart-1..5 exist as semantic chart tokens, so the three extra
// CPU modes fall back to muted-foreground / destructive / border.
const CPU_MODES: { key: keyof Omit<CpuPoint, "t">; color: string }[] = [
  { key: "system", color: "var(--chart-1)" },
  { key: "user", color: "var(--chart-2)" },
  { key: "iowait", color: "var(--chart-3)" },
  { key: "nice", color: "var(--chart-4)" },
  { key: "irq", color: "var(--chart-5)" },
  { key: "softirq", color: "var(--muted-foreground)" },
  { key: "steal", color: "var(--destructive)" },
  { key: "idle", color: "var(--border)" },
];

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function hhmm(iso: string): string {
  // ISO timestamp -> HH:MM. Slice the time portion without parsing a Date.
  return iso.slice(11, 16);
}

/**
 * Stacked CPU-mode area chart. Each scrape is one point; the eight modes
 * stack to the per-sample CPU total.
 */
export function CpuChart({
  data,
  isLoading,
  error,
}: {
  data: CpuPoint[];
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
    system: finite(p.system),
    user: finite(p.user),
    iowait: finite(p.iowait),
    irq: finite(p.irq),
    softirq: finite(p.softirq),
    nice: finite(p.nice),
    steal: finite(p.steal),
    idle: finite(p.idle),
  }));

  return (
    <div className="h-[260px] rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={safe} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            itemStyle={{ color: "var(--popover-foreground)" }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            labelFormatter={(v) => hhmm(String(v))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {CPU_MODES.map(({ key, color }) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stackId="cpu"
              stroke={color}
              fill={color}
              fillOpacity={0.5}
              strokeWidth={1}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
