"use client";

import { StandardErrorBoundary } from "@/components/standard";
import type {
  CurrentSnapshot,
  HistorySnapshot,
} from "@/lib/supabase-metrics/types";

import { CacheHitChart } from "./cache-hit-chart";
import { ConnectionsChart } from "./connections-chart";
import { DeadlocksReplicationChart } from "./deadlocks-replication-chart";
import { PoolPanel } from "./pool-panel";
import { TransactionsChart } from "./transactions-chart";

/**
 * Postgres + connection-pool section. Each chart is wrapped in its own
 * error boundary so a single failing series degrades to a localized
 * card rather than blanking the whole section.
 */
export function PostgresSection({
  history,
  current,
  isLoading,
  error,
}: {
  history: HistorySnapshot | null;
  current: CurrentSnapshot | null;
  isLoading?: boolean;
  error?: string | null;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Postgres &amp; connection pool
      </h2>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <StandardErrorBoundary context="Connection pool panel">
            <PoolPanel
              pool={history?.pool ?? []}
              current={current}
              isLoading={isLoading}
              error={error}
            />
          </StandardErrorBoundary>
        </div>
        <StandardErrorBoundary context="Connections chart">
          <ConnectionsChart
            data={history?.postgres.connections ?? []}
            isLoading={isLoading}
            error={error}
          />
        </StandardErrorBoundary>
        <StandardErrorBoundary context="Transactions chart">
          <TransactionsChart
            data={history?.postgres.transactions ?? []}
            isLoading={isLoading}
            error={error}
          />
        </StandardErrorBoundary>
        <StandardErrorBoundary context="Cache hit chart">
          <CacheHitChart
            data={history?.postgres.cacheHitRatio ?? []}
            isLoading={isLoading}
            error={error}
          />
        </StandardErrorBoundary>
        <StandardErrorBoundary context="Deadlocks and replication chart">
          <DeadlocksReplicationChart
            deadlocks={history?.postgres.deadlocks ?? []}
            replication={history?.postgres.replicationLagBytes ?? []}
            isLoading={isLoading}
            error={error}
          />
        </StandardErrorBoundary>
      </div>
    </section>
  );
}
