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
import type {
  DeadlocksPoint,
  ReplicationLagPoint,
} from "@/lib/supabase-metrics/types";

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
 * Two stacked mini-panels: deadlocks per second on top, replication lag
 * bytes below. Replication lag is null on instances without a replica;
 * the lower pane renders an inline empty placeholder rather than a flat
 * zero line that would imply healthy replication that does not exist.
 */
export function DeadlocksReplicationChart({
  deadlocks,
  replication,
  isLoading,
  error,
}: {
  deadlocks: DeadlocksPoint[];
  replication: ReplicationLagPoint[];
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
  if (isLoading && deadlocks.length === 0 && replication.length === 0) {
    return (
      <div className="space-y-2">
        <div className="h-[180px] animate-pulse rounded-lg bg-muted" />
        <div className="h-[180px] animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  const safeDeadlocks = deadlocks.map((p) => ({
    t: p.t,
    perSec: finite(p.perSec),
  }));
  // Preserve null so connectNulls=false leaves a real gap; only coerce
  // actual numeric values.
  const safeReplication = replication.map((p) => ({
    t: p.t,
    bytes: p.bytes == null ? null : finite(p.bytes),
  }));
  const hasReplication = safeReplication.some((p) => p.bytes != null);

  return (
    <div className="space-y-2">
      {deadlocks.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-sm text-muted-foreground">
          No data in this window
        </div>
      ) : (
        <div className="h-[180px] rounded-lg border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={safeDeadlocks}
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
                tickFormatter={(v) => Number(v).toFixed(1)}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                itemStyle={{ color: "var(--popover-foreground)" }}
                labelStyle={{ color: "var(--muted-foreground)" }}
                labelFormatter={(v) => hhmm(String(v))}
                formatter={(value) => [`${Number(value).toFixed(2)}/s`, "Deadlocks"]}
              />
              <Line
                type="monotone"
                dataKey="perSec"
                stroke="var(--destructive)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!hasReplication ? (
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-sm text-muted-foreground">
          No replication lag data
        </div>
      ) : (
        <div className="h-[180px] rounded-lg border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={safeReplication}
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
                tickFormatter={(v) => fmtBytes(Number(v))}
                width={64}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                itemStyle={{ color: "var(--popover-foreground)" }}
                labelStyle={{ color: "var(--muted-foreground)" }}
                labelFormatter={(v) => hhmm(String(v))}
                formatter={(value) => [fmtBytes(Number(value)), "Replication lag"]}
              />
              <Line
                type="monotone"
                dataKey="bytes"
                stroke="var(--chart-4)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
