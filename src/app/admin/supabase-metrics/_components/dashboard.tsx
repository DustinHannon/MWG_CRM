"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { StandardErrorBoundary } from "@/components/standard";
import type { Range, Snapshot } from "@/lib/supabase-metrics/types";

import { CpuChart } from "./cpu-chart";
import { DiskChart } from "./disk-chart";
import { HeaderBar } from "./header-bar";
import { MemoryChart } from "./memory-chart";
import { NetworkChart } from "./network-chart";
import { QuickRow } from "./quick-row";
import { ReplicationChart } from "./replication-chart";

/**
 * Client dashboard. Owns range state + the polling query. The server
 * component did the initial fetch + the once-per-view audit; this
 * polls /api/admin/supabase-metrics/snapshot WITHOUT initial=1 so the
 * 60s refresh doesn't emit an audit row per poll.
 *
 * Query options per plan: staleTime 30s, refetchInterval 60s,
 * refetchOnWindowFocus off, refetchIntervalInBackground off — a
 * backgrounded tab stops polling, and one cache entry per range
 * bounds memory at 5 entries.
 */

async function fetchSnapshot(range: Range): Promise<Snapshot> {
  const res = await fetch(
    `/api/admin/supabase-metrics/snapshot?range=${encodeURIComponent(range)}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`Snapshot request failed (${res.status})`);
  }
  return (await res.json()) as Snapshot;
}

export function SupabaseMetricsDashboard({
  initialData,
}: {
  initialData: Snapshot | null;
}) {
  const [range, setRange] = useState<Range>("30m");

  const query = useQuery({
    queryKey: ["supabase-metrics", range],
    queryFn: () => fetchSnapshot(range),
    // initialData only applies to the default range — switching range
    // forces a real fetch (different query key, no seeded data).
    initialData: range === "30m" ? (initialData ?? undefined) : undefined,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });

  const snapshot = query.data ?? null;
  const current = snapshot?.current ?? null;
  const history = snapshot?.history ?? null;
  const meta = snapshot?.meta ?? null;
  const isLoading = query.isPending && !snapshot;
  const queryError = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : "Failed to load metrics"
    : null;

  return (
    <div className="mt-6 space-y-8">
      <HeaderBar
        range={range}
        onRangeChange={setRange}
        onRefresh={() => void query.refetch()}
        isFetching={query.isFetching}
        meta={meta}
      />

      <StandardErrorBoundary context="Quick stats">
        <QuickRow current={current} isLoading={isLoading} />
      </StandardErrorBoundary>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <StandardErrorBoundary context="CPU chart">
          <CpuChart
            data={history?.cpu ?? []}
            isLoading={isLoading}
            error={queryError}
          />
        </StandardErrorBoundary>
        <StandardErrorBoundary context="Memory chart">
          <MemoryChart
            data={history?.memory ?? []}
            isLoading={isLoading}
            error={queryError}
          />
        </StandardErrorBoundary>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <StandardErrorBoundary context="Network chart">
          <NetworkChart
            data={history?.network ?? []}
            isLoading={isLoading}
            error={queryError}
          />
        </StandardErrorBoundary>
        <StandardErrorBoundary context="Disk chart">
          <DiskChart
            data={history?.disk ?? []}
            isLoading={isLoading}
            error={queryError}
          />
        </StandardErrorBoundary>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <StandardErrorBoundary context="Replication lag chart">
          <ReplicationChart
            data={history?.replicationLagBytes ?? []}
            isLoading={isLoading}
            error={queryError}
          />
        </StandardErrorBoundary>
      </div>
    </div>
  );
}
