"use client";

import { StandardEmptyState } from "@/components/standard";
import type { CurrentSnapshot } from "@/lib/supabase-metrics/types";

import { Gauge } from "./gauge";
import { StatCard } from "./stat-card";

interface QuickRowProps {
  current: CurrentSnapshot | null;
  isLoading?: boolean;
}

function num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function formatBytes(n: number): string {
  const bytes = Number.isFinite(n) && n >= 0 ? n : 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

export function QuickRow({ current, isLoading }: QuickRowProps) {
  if (!current) {
    if (isLoading) {
      return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-[120px] animate-pulse rounded-lg bg-muted"
            />
          ))}
        </div>
      );
    }
    return (
      <StandardEmptyState
        title="No data yet"
        description="Metrics will appear after the first scrape."
      />
    );
  }

  const cpuCount = num(current.cpuCount);
  const load5Max = cpuCount > 0 ? cpuCount * 2 : 2;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Gauge
          label="CPU busy"
          value={num(current.cpuBusyPct)}
          unit="%"
        />
        <Gauge
          label="RAM used"
          value={num(current.ramUsedPct)}
          unit="%"
        />
        <Gauge
          label="Swap used"
          value={num(current.swapUsedPct)}
          unit="%"
          thresholds={{ warn: 30, danger: 60 }}
        />
        <Gauge
          label="Root FS used"
          value={num(current.rootFsUsedPct)}
          unit="%"
        />
        <Gauge label="Load 5m" value={num(current.load5)} max={load5Max} />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="CPU" value={`${cpuCount} vCPU`} />
        <StatCard
          label="RAM total"
          value={formatBytes(current.ramTotalBytes)}
        />
        <StatCard
          label="Root FS total"
          value={formatBytes(current.rootFsTotalBytes)}
        />
      </div>
    </div>
  );
}
