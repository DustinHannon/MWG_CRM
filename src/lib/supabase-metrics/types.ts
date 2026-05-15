/**
 * Shared types for the Supabase Metrics dashboard. Imported by the
 * snapshot API, the queries module, and every UI component.
 *
 * `Snapshot` is the wire shape returned by GET
 * /api/admin/supabase-metrics/snapshot. The UI handles `current === null`
 * and `history === null` as "no data yet" — the page never breaks on a
 * degraded response.
 */

export type Range = "5m" | "30m" | "1h" | "6h" | "24h";

export const VALID_RANGES: readonly Range[] = ["5m", "30m", "1h", "6h", "24h"];

export interface CurrentSnapshot {
  asOf: string;
  cpuBusyPct: number;
  load5: number;
  load15: number;
  ramUsedPct: number;
  swapUsedPct: number;
  rootFsUsedPct: number;
  cpuCount: number;
  uptimeSeconds: number;
  ramTotalBytes: number;
  swapTotalBytes: number;
  rootFsTotalBytes: number;
  dataFsTotalBytes: number;
}

export interface CpuPoint {
  t: string;
  system: number;
  user: number;
  iowait: number;
  irq: number;
  softirq: number;
  nice: number;
  steal: number;
  idle: number;
}

export interface MemoryPoint {
  t: string;
  used: number;
  cached: number;
  buffers: number;
  free: number;
  swapUsed: number;
  total: number;
}

export interface NetworkPoint {
  t: string;
  recvBytesPerSec: number;
  transBytesPerSec: number;
}

export interface DiskPoint {
  t: string;
  rootUsedPct: number;
  dataUsedPct: number;
  ioBalancePct: number | null;
}

export interface ConnectionsPoint {
  t: string;
  active: number;
  idle: number;
  max: number;
}

export interface TransactionsPoint {
  t: string;
  commitsPerSec: number;
  rollbacksPerSec: number;
}

export interface CacheHitPoint {
  t: string;
  ratio: number;
}

export interface DeadlocksPoint {
  t: string;
  perSec: number;
}

export interface ReplicationLagPoint {
  t: string;
  bytes: number | null;
}

export interface HistorySnapshot {
  cpu: CpuPoint[];
  memory: MemoryPoint[];
  network: NetworkPoint[];
  disk: DiskPoint[];
  postgres: {
    connections: ConnectionsPoint[];
    transactions: TransactionsPoint[];
    cacheHitRatio: CacheHitPoint[];
    deadlocks: DeadlocksPoint[];
    replicationLagBytes: ReplicationLagPoint[];
  };
}

export interface SnapshotMeta {
  rangeMs: number;
  pointCount: number;
  lastScrapeAt: string | null;
  scrapeGaps: number;
  error?: "transient";
}

export interface Snapshot {
  asOf: string | null;
  current: CurrentSnapshot | null;
  history: HistorySnapshot | null;
  meta: SnapshotMeta;
}

export function rangeToMs(r: Range): number {
  switch (r) {
    case "5m":
      return 5 * 60 * 1000;
    case "30m":
      return 30 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "6h":
      return 6 * 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
  }
}

/**
 * Bucket width for the history downsample. Each range gets a coarser
 * bucket so the wire payload stays around the same size (~60-200
 * points per series).
 */
export function rangeToBucketSeconds(r: Range): number {
  switch (r) {
    case "5m":
      return 60;
    case "30m":
      return 60;
    case "1h":
      return 60;
    case "6h":
      return 5 * 60;
    case "24h":
      return 15 * 60;
  }
}

export function parseRange(input: string | null | undefined): Range | null {
  if (input == null) return null;
  return (VALID_RANGES as readonly string[]).includes(input)
    ? (input as Range)
    : null;
}
