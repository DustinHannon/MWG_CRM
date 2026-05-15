"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { StandardEmptyState } from "@/components/standard";
import type {
  CurrentSnapshot,
  PoolPoint,
} from "@/lib/supabase-metrics/types";

const TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  fontSize: "12px",
} as const;

function finite(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function hhmm(iso: string): string {
  // ISO timestamp -> HH:MM. Slice the time portion without parsing a Date.
  return iso.slice(11, 16);
}

// Percentage of a capacity, clamped 0..100, division-by-zero safe.
function pct(used: number, total: number): number {
  if (total <= 0) return 0;
  const v = (used / total) * 100;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function UtilizationBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{ width: `${value}%`, backgroundColor: color }}
      />
    </div>
  );
}

/**
 * Connection-pool panel. Motivated by the transaction-pool incident:
 * the three tiles must answer "how many of each, out of the max" at a
 * glance, and the chart shows the same numbers trending over the window
 * so a slow climb toward the ceiling is visible before it saturates.
 */
export function PoolPanel({
  pool,
  current,
  isLoading,
  error,
}: {
  pool: PoolPoint[];
  current: CurrentSnapshot | null;
  isLoading?: boolean;
  error?: string | null;
}) {
  if (error) {
    return (
      <StandardEmptyState
        variant="card"
        title="Pool panel unavailable"
        description={error}
      />
    );
  }
  if (isLoading && pool.length === 0 && current == null) {
    return <div className="h-[360px] animate-pulse rounded-lg bg-muted" />;
  }

  const serversActive = finite(current?.supavisorServersActive);
  const serversIdle = finite(current?.supavisorServersIdle);
  const poolSize = finite(current?.poolSize);
  const clientsActive = finite(current?.supavisorClientsActive);
  const clientsWaiting = finite(current?.supavisorClientsWaiting);
  const pgBackends = finite(current?.pgBackends);
  const pgMaxConnections = finite(current?.pgMaxConnections);

  const serverPct = pct(serversActive, poolSize);
  const pgPct = pct(pgBackends, pgMaxConnections);
  const pgBarColor =
    pgPct > 80 ? "var(--destructive)" : "var(--chart-1)";

  const safePool = pool.map((p) => ({
    t: p.t,
    serversActive: finite(p.serversActive),
    serversIdle: finite(p.serversIdle),
    clientsWaiting: finite(p.clientsWaiting),
  }));
  const latestPoolSize = finite(pool[pool.length - 1]?.poolSize);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Supavisor servers
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground tabular-nums">
            {serversActive}
            <span className="text-base font-normal text-muted-foreground">
              {" / "}
              {poolSize}
            </span>
          </p>
          <UtilizationBar value={serverPct} color="var(--chart-1)" />
          <p className="mt-2 text-xs text-muted-foreground">
            Active backends out of pool size
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Supavisor clients
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground tabular-nums">
            active {clientsActive}
            <span className="text-base font-normal text-muted-foreground">
              {" · "}
            </span>
            <span
              className={
                clientsWaiting > 0
                  ? "text-destructive"
                  : "text-foreground"
              }
            >
              waiting {clientsWaiting}
            </span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Waiting clients indicate pool saturation
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Postgres backends
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground tabular-nums">
            {pgBackends}
            <span className="text-base font-normal text-muted-foreground">
              {" / "}
              {pgMaxConnections}
            </span>
          </p>
          <UtilizationBar value={pgPct} color={pgBarColor} />
          <p className="mt-2 text-xs text-muted-foreground">
            Live backends out of max connections
          </p>
        </div>
      </div>

      {pool.length === 0 ? (
        <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed border-border bg-card text-sm text-muted-foreground">
          No data in this window
        </div>
      ) : (
        <div className="h-[260px] rounded-lg border border-border bg-card p-4">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={safePool}
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
              {latestPoolSize > 0 ? (
                <ReferenceLine
                  y={latestPoolSize}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="4 4"
                  label={{
                    value: "pool size",
                    position: "right",
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                  }}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="serversActive"
                stackId="srv"
                stroke="var(--chart-1)"
                fill="var(--chart-1)"
                fillOpacity={0.5}
                strokeWidth={1}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="serversIdle"
                stackId="srv"
                stroke="var(--border)"
                fill="var(--border)"
                fillOpacity={0.5}
                strokeWidth={1}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="clientsWaiting"
                stroke="var(--destructive)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
