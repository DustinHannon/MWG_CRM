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

function formatUptime(s: number): string {
  const total = Number.isFinite(s) && s >= 0 ? Math.floor(s) : 0;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function QuickRow({ current, isLoading }: QuickRowProps) {
  if (!current) {
    if (isLoading) {
      return (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
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
  const poolSize = num(current.poolSize);
  const serversActive = num(current.supavisorServersActive);
  const poolUtilPct = poolSize > 0 ? (serversActive / poolSize) * 100 : 0;
  const load5Max = cpuCount > 0 ? cpuCount * 2 : 2;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
        <Gauge label="Pool used" value={poolUtilPct} unit="%" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Uptime"
          value={formatUptime(current.uptimeSeconds)}
        />
        <StatCard label="CPU" value={`${cpuCount} vCPU`} />
        <StatCard
          label="RAM total"
          value={formatBytes(current.ramTotalBytes)}
        />
        <StatCard
          label="PG backends"
          value={`${num(current.pgBackends)} / ${num(
            current.pgMaxConnections,
          )}`}
        />
        <StatCard
          label="Supavisor clients"
          value={`active ${num(current.supavisorClientsActive)} · waiting ${num(
            current.supavisorClientsWaiting,
          )}`}
        />
      </div>
    </div>
  );
}
