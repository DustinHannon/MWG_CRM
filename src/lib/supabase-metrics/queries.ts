import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { logger } from "@/lib/logger";

import {
  type CpuPoint,
  type CurrentSnapshot,
  type DiskPoint,
  type HistorySnapshot,
  type MemoryPoint,
  type NetworkPoint,
  type Range,
  type ReplicationLagPoint,
  type Snapshot,
  rangeToBucketSeconds,
  rangeToMs,
} from "./types";

/**
 * Read-side queries for the /admin/supabase-metrics dashboard.
 *
 * Every query is single-statement, scoped to the bounded time window,
 * and reads the append-only `supabase_metrics` table only. No FKs to
 * other tables; no chance of cross-table interference.
 *
 * Statement timeout of 8s is set on the transaction by the caller via
 * `SET LOCAL statement_timeout`. If a planner regression makes the
 * query slow, it aborts cleanly — the API route returns a degraded
 * payload rather than starving the pool.
 *
 * Counter metrics need rate-over-time. Postgres window functions do
 * the bucketing in-database; we ship rates, not raw counters, to the
 * UI so charts render the same shape across browsers and don't depend
 * on client-side counter-reset logic.
 */

interface RawSample {
  bucket: string;
  metricName: string;
  labels: Record<string, string>;
  value: number;
}

const STATEMENT_TIMEOUT = "8s";

const CURRENT_WINDOW_SECONDS = 180;

export async function fetchSnapshot(input: {
  range: Range;
  now?: Date;
}): Promise<Snapshot> {
  const now = input.now ?? new Date();
  const rangeMs = rangeToMs(input.range);
  const bucketSec = rangeToBucketSeconds(input.range);
  const since = new Date(now.getTime() - rangeMs);

  return db.transaction(async (tx) => {
    // set_config(name, value, is_local=true) is exactly `SET LOCAL`
    // (transaction-scoped, released at COMMIT — Supavisor-safe) but
    // takes the value as a bind parameter, so no string interpolation
    // into SQL. STATEMENT_TIMEOUT is a module constant regardless.
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
    );

    const lastScrapeAt = await readLastScrapeAt(tx);
    const current = lastScrapeAt
      ? await buildCurrentSnapshot(tx, lastScrapeAt)
      : null;
    const history = await buildHistorySnapshot(tx, since, now, bucketSec);

    const allPoints =
      history.cpu.length +
      history.memory.length +
      history.network.length +
      history.disk.length +
      history.replicationLagBytes.length;

    const scrapeGaps = await countScrapeGaps(tx, since, now);

    return {
      asOf: current ? current.asOf : null,
      current,
      history,
      meta: {
        rangeMs,
        pointCount: allPoints,
        lastScrapeAt: lastScrapeAt ? lastScrapeAt.toISOString() : null,
        scrapeGaps,
      },
    };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function readLastScrapeAt(tx: Tx): Promise<Date | null> {
  const rows = await tx.execute<{ time: Date }>(sql`
    SELECT MAX(time) AS time FROM supabase_metrics
    WHERE time >= now() - interval '1 day'
  `);
  const first = (rows as unknown as Array<{ time: Date | null }>)[0];
  if (!first || !first.time) return null;
  return new Date(first.time);
}

async function countScrapeGaps(
  tx: Tx,
  since: Date,
  now: Date,
): Promise<number> {
  // Count minute boundaries within the window that have NO sample, but
  // never count minutes that predate the first-ever scrape — otherwise
  // a brand-new table reports the whole window as "gaps". The expected
  // series starts at greatest(since, first-scrape-minute); the MIN read
  // is a cheap indexed scan. Below ~10 minutes of accumulated data the
  // gap count is statistically meaningless, so report 0.
  const minutes = Math.floor((now.getTime() - since.getTime()) / 60_000);
  if (minutes <= 0) return 0;
  const rows = await tx.execute<{ missing: string; observed: string }>(sql`
    WITH bounds AS (
      SELECT
        greatest(
          date_trunc('minute', ${since.toISOString()}::timestamptz),
          date_trunc('minute', (SELECT MIN(time) FROM supabase_metrics))
        ) AS lo,
        date_trunc('minute', ${now.toISOString()}::timestamptz) AS hi
    ),
    expected AS (
      SELECT generate_series(b.lo, b.hi, interval '1 minute') AS t
      FROM bounds b
      WHERE b.lo IS NOT NULL AND b.lo <= b.hi
    ),
    seen AS (
      SELECT DISTINCT date_trunc('minute', time) AS t FROM supabase_metrics
      WHERE time >= ${since.toISOString()}::timestamptz
        AND time <= ${now.toISOString()}::timestamptz
    )
    SELECT
      COUNT(*) FILTER (WHERE seen.t IS NULL)::text AS missing,
      COUNT(*)::text AS observed
    FROM expected
    LEFT JOIN seen USING (t)
  `);
  const first = (rows as unknown as Array<{
    missing: string | null;
    observed: string | null;
  }>)[0];
  const observed = first?.observed
    ? Number.parseInt(first.observed, 10)
    : 0;
  if (observed < 10) return 0;
  return first?.missing ? Number.parseInt(first.missing, 10) : 0;
}

async function buildCurrentSnapshot(
  tx: Tx,
  lastScrapeAt: Date,
): Promise<CurrentSnapshot> {
  const lo = new Date(lastScrapeAt.getTime() - CURRENT_WINDOW_SECONDS * 1000);
  // Pull all metrics within the latest-scrape window; use DISTINCT ON
  // to keep only the most recent (metric_name, labels) tuple.
  const rows = await tx.execute<{
    metric_name: string;
    labels: Record<string, string>;
    value: number;
  }>(sql`
    SELECT DISTINCT ON (metric_name, labels) metric_name, labels, value
    FROM supabase_metrics
    WHERE time >= ${lo.toISOString()}::timestamptz
      AND time <= ${lastScrapeAt.toISOString()}::timestamptz
    ORDER BY metric_name, labels, time DESC
  `);
  const samples = rows as unknown as Array<{
    metric_name: string;
    labels: Record<string, string>;
    value: number;
  }>;

  const byName = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
  for (const s of samples) {
    const arr = byName.get(s.metric_name) ?? [];
    arr.push({ labels: s.labels ?? {}, value: Number(s.value) });
    byName.set(s.metric_name, arr);
  }

  const cpuModes = byName.get("node_cpu_seconds_total") ?? [];
  const idleSum = sumWhere(cpuModes, (s) => s.labels.mode === "idle");
  const allSum = sumValues(cpuModes);
  const cpuBusyPct = allSum > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleSum / allSum))) : 0;

  const memTotal = firstValue(byName.get("node_memory_MemTotal_bytes"));
  const memAvail = firstValue(byName.get("node_memory_MemAvailable_bytes"));
  const ramUsedPct = memTotal > 0 ? clampPct(100 * (1 - memAvail / memTotal)) : 0;

  const swapTotal = firstValue(byName.get("node_memory_SwapTotal_bytes"));
  const swapFree = firstValue(byName.get("node_memory_SwapFree_bytes"));
  const swapUsedPct = swapTotal > 0 ? clampPct(100 * (1 - swapFree / swapTotal)) : 0;

  const fs = byName.get("node_filesystem_size_bytes") ?? [];
  const fsAvail = byName.get("node_filesystem_avail_bytes") ?? [];
  const rootFs = fs.find((s) => s.labels.mountpoint === "/");
  const rootFsAvail = fsAvail.find((s) => s.labels.mountpoint === "/");
  const rootFsTotal = rootFs?.value ?? 0;
  const rootFsAvailVal = rootFsAvail?.value ?? 0;
  const rootFsUsedPct =
    rootFsTotal > 0
      ? clampPct(100 * (1 - rootFsAvailVal / rootFsTotal))
      : 0;

  // Data partition: pick the largest non-root mountpoint as the "data" disk.
  const dataFs = fs
    .filter((s) => s.labels.mountpoint && s.labels.mountpoint !== "/")
    .sort((a, b) => b.value - a.value)[0];
  const dataFsTotalBytes = dataFs?.value ?? 0;

  const cpuCount = new Set(
    cpuModes.map((s) => s.labels.cpu).filter(Boolean),
  ).size;

  const load5 = firstValue(byName.get("node_load5"));
  const load15 = firstValue(byName.get("node_load15"));

  return {
    asOf: lastScrapeAt.toISOString(),
    cpuBusyPct,
    load5,
    load15,
    ramUsedPct,
    swapUsedPct,
    rootFsUsedPct,
    cpuCount,
    ramTotalBytes: memTotal,
    swapTotalBytes: swapTotal,
    rootFsTotalBytes: rootFsTotal,
    dataFsTotalBytes,
  };
}

async function buildHistorySnapshot(
  tx: Tx,
  since: Date,
  now: Date,
  bucketSec: number,
): Promise<HistorySnapshot> {
  // Bucket gauges by AVG-in-bucket; counters get the LAST value in
  // each bucket then rate is computed via LAG below.
  // Single query for ALL needed metrics — narrower row set than
  // multiple round trips, cleaner failure semantics (one statement
  // timeout covers everything).
  const allowedNames = METRICS_FOR_HISTORY;
  // F-01 keystone: bin against the UNIX epoch, NOT `since`. The JS
  // `enumerateBuckets` floors timestamps to the epoch grid
  // (Math.*(t/step)*step); date_bin's third arg is the bin origin, so
  // anchoring it to '1970-01-01T00:00:00Z' makes every SQL bucket land
  // on the exact same boundary the JS side computes. With a 60/300/900
  // second interval the epoch-aligned bins always carry :00 seconds, so
  // the to_char label is byte-identical to the ISO string
  // enumerateBuckets emits (`YYYY-MM-DDTHH:MM:00Z`). Origin = `since`
  // (sub-minute seconds) produced a disjoint grid and zero-overlap join
  // → every chart rendered empty.
  const rows = await tx.execute<{
    bucket: string;
    metric_name: string;
    labels: Record<string, string>;
    value: number;
  }>(sql`
    SELECT
      to_char(date_bin(${`${bucketSec} seconds`}::interval, time, '1970-01-01T00:00:00Z'::timestamptz), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
      metric_name,
      labels,
      AVG(value) AS value
    FROM supabase_metrics
    WHERE time >= ${since.toISOString()}::timestamptz
      AND time <= ${now.toISOString()}::timestamptz
      AND metric_name IN (${sql.join(
        allowedNames.map((n) => sql`${n}`),
        sql`, `,
      )})
    GROUP BY 1, 2, 3
    ORDER BY 2, 3, 1
  `);

  const raw: RawSample[] = (rows as unknown as Array<{
    bucket: string;
    metric_name: string;
    labels: Record<string, string>;
    value: number;
  }>).map((r) => ({
    bucket: r.bucket,
    metricName: r.metric_name,
    labels: r.labels ?? {},
    value: Number(r.value),
  }));

  // Group raw samples by (metric, labels) for easier consumption.
  const grouped = new Map<string, Map<string, RawSample[]>>();
  for (const s of raw) {
    const labelKey = stableLabelKey(s.labels);
    const inner = grouped.get(s.metricName) ?? new Map();
    const arr = inner.get(labelKey) ?? [];
    arr.push(s);
    inner.set(labelKey, arr);
    grouped.set(s.metricName, inner);
  }

  const buckets = enumerateBuckets(since, now, bucketSec);

  return {
    cpu: buildCpuSeries(grouped, buckets),
    memory: buildMemorySeries(grouped, buckets),
    network: buildNetworkSeries(grouped, buckets),
    disk: buildDiskSeries(grouped, buckets),
    replicationLagBytes: buildReplicationLagSeries(grouped, buckets),
  };
}

/* ----------------------------- helpers ----------------------------- */

// Only the emitted-28 names that a surviving history builder actually
// reads. Anything else would be filtered to an empty group and waste
// the IN-list / row scan.
const METRICS_FOR_HISTORY: string[] = [
  "node_cpu_seconds_total",
  "node_memory_MemTotal_bytes",
  "node_memory_MemAvailable_bytes",
  "node_memory_MemFree_bytes",
  "node_memory_Cached_bytes",
  "node_memory_Buffers_bytes",
  "node_memory_SwapTotal_bytes",
  "node_memory_SwapFree_bytes",
  "node_filesystem_size_bytes",
  "node_filesystem_avail_bytes",
  "node_network_receive_bytes_total",
  "node_network_transmit_bytes_total",
  "node_disk_reads_completed_total",
  "node_disk_writes_completed_total",
  "replication_realtime_lag_bytes",
];

function enumerateBuckets(since: Date, now: Date, bucketSec: number): string[] {
  const step = bucketSec * 1000;
  // Epoch-aligned grid, identical to the SQL date_bin origin. The first
  // emitted bucket is CEIL'd, not FLOOR'd: SQL filters `time >= since`,
  // so a floored first bucket would predate every row it could contain
  // and render as a guaranteed empty leading point. Ceiling guarantees
  // the first JS bucket is one SQL can populate. `end` stays floored —
  // it's the last fully-started bucket.
  const start = Math.ceil(since.getTime() / step) * step;
  const end = Math.floor(now.getTime() / step) * step;
  const out: string[] = [];
  for (let t = start; t <= end; t += step) {
    out.push(new Date(t).toISOString().replace(/\.\d+Z$/, "Z"));
  }
  return out;
}

function stableLabelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function sumValues(arr: Array<{ value: number }>): number {
  let s = 0;
  for (const x of arr) s += Number(x.value);
  return s;
}

function sumWhere<T>(arr: T[], pred: (x: T) => boolean): number {
  let s = 0;
  for (const x of arr as Array<T & { value: number }>) {
    if (pred(x)) s += Number(x.value);
  }
  return s;
}

function firstValue(arr: Array<{ value: number }> | undefined): number {
  if (!arr || arr.length === 0) return 0;
  return Number(arr[0]?.value ?? 0);
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Compute a per-bucket rate from a counter series. Returns the per-
 * second rate between consecutive buckets. Handles counter resets by
 * emitting null when the value drops. Returns null for the first
 * point in a series (no prior reference).
 */
function counterRate(
  series: RawSample[] | undefined,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!series || series.length === 0) return out;
  const sorted = [...series].sort((a, b) => a.bucket.localeCompare(b.bucket));
  let prev: RawSample | null = null;
  for (const s of sorted) {
    if (!prev) {
      out.set(s.bucket, null);
      prev = s;
      continue;
    }
    const dv = s.value - prev.value;
    if (dv < 0) {
      // Counter reset — null this bucket.
      out.set(s.bucket, null);
      prev = s;
      continue;
    }
    const dt = (new Date(s.bucket).getTime() - new Date(prev.bucket).getTime()) / 1000;
    out.set(s.bucket, dt > 0 ? dv / dt : null);
    prev = s;
  }
  return out;
}

function buildCpuSeries(
  grouped: Map<string, Map<string, RawSample[]>>,
  buckets: string[],
): CpuPoint[] {
  const cpuMap = grouped.get("node_cpu_seconds_total");
  if (!cpuMap || cpuMap.size === 0) return [];

  // Compute per-mode rate-of-time-spent across all CPUs in each bucket.
  // The rate is total CPU-seconds-per-second in that mode; divide by
  // CPU count to get a 0..1 fraction. For display we ship raw fractions
  // and let the UI normalize. Stack height = sum of modes (~= cpuCount).
  const modeBuckets = new Map<string, Map<string, number>>(); // mode -> bucket -> sum
  let cpuCount = 0;
  for (const [labelKey, series] of cpuMap) {
    const sample = series[0];
    const mode = sample?.labels.mode ?? "unknown";
    const cpuId = sample?.labels.cpu;
    if (cpuId) cpuCount = Math.max(cpuCount, Number.parseInt(cpuId, 10) + 1);
    void labelKey;
    const rates = counterRate(series);
    const bucketSum = modeBuckets.get(mode) ?? new Map();
    for (const [bucket, r] of rates) {
      if (r == null) continue;
      bucketSum.set(bucket, (bucketSum.get(bucket) ?? 0) + r);
    }
    modeBuckets.set(mode, bucketSum);
  }

  const normalize = cpuCount > 0 ? cpuCount : 1;
  return buckets.map((t) => ({
    t,
    system: (modeBuckets.get("system")?.get(t) ?? 0) / normalize,
    user: (modeBuckets.get("user")?.get(t) ?? 0) / normalize,
    iowait: (modeBuckets.get("iowait")?.get(t) ?? 0) / normalize,
    irq: (modeBuckets.get("irq")?.get(t) ?? 0) / normalize,
    softirq: (modeBuckets.get("softirq")?.get(t) ?? 0) / normalize,
    nice: (modeBuckets.get("nice")?.get(t) ?? 0) / normalize,
    steal: (modeBuckets.get("steal")?.get(t) ?? 0) / normalize,
    idle: (modeBuckets.get("idle")?.get(t) ?? 0) / normalize,
  }));
}

function gaugeMapByBucket(
  grouped: Map<string, Map<string, RawSample[]>>,
  name: string,
  labelFilter?: (l: Record<string, string>) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  const map = grouped.get(name);
  if (!map) return out;
  for (const series of map.values()) {
    const first = series[0];
    if (labelFilter && !labelFilter(first?.labels ?? {})) continue;
    for (const s of series) {
      const cur = out.get(s.bucket);
      out.set(s.bucket, cur == null ? s.value : cur + s.value);
    }
  }
  return out;
}

function buildMemorySeries(
  grouped: Map<string, Map<string, RawSample[]>>,
  buckets: string[],
): MemoryPoint[] {
  const total = gaugeMapByBucket(grouped, "node_memory_MemTotal_bytes");
  const avail = gaugeMapByBucket(grouped, "node_memory_MemAvailable_bytes");
  const cached = gaugeMapByBucket(grouped, "node_memory_Cached_bytes");
  const buffers = gaugeMapByBucket(grouped, "node_memory_Buffers_bytes");
  const free = gaugeMapByBucket(grouped, "node_memory_MemFree_bytes");
  const swapTotal = gaugeMapByBucket(grouped, "node_memory_SwapTotal_bytes");
  const swapFree = gaugeMapByBucket(grouped, "node_memory_SwapFree_bytes");

  return buckets.map((t) => {
    const totalV = total.get(t) ?? 0;
    const availV = avail.get(t) ?? 0;
    const usedV = Math.max(0, totalV - availV);
    return {
      t,
      used: usedV,
      cached: cached.get(t) ?? 0,
      buffers: buffers.get(t) ?? 0,
      free: free.get(t) ?? 0,
      swapUsed: Math.max(0, (swapTotal.get(t) ?? 0) - (swapFree.get(t) ?? 0)),
      total: totalV,
    };
  });
}

function buildNetworkSeries(
  grouped: Map<string, Map<string, RawSample[]>>,
  buckets: string[],
): NetworkPoint[] {
  const recv = aggregateRateAcrossLabels(grouped, "node_network_receive_bytes_total");
  const trans = aggregateRateAcrossLabels(grouped, "node_network_transmit_bytes_total");
  return buckets.map((t) => ({
    t,
    recvBytesPerSec: recv.get(t) ?? 0,
    transBytesPerSec: trans.get(t) ?? 0,
  }));
}

function aggregateRateAcrossLabels(
  grouped: Map<string, Map<string, RawSample[]>>,
  name: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const map = grouped.get(name);
  if (!map) return out;
  for (const series of map.values()) {
    const rates = counterRate(series);
    for (const [bucket, r] of rates) {
      if (r == null) continue;
      out.set(bucket, (out.get(bucket) ?? 0) + r);
    }
  }
  return out;
}

function buildDiskSeries(
  grouped: Map<string, Map<string, RawSample[]>>,
  buckets: string[],
): DiskPoint[] {
  const sizeRoot = gaugeMapByBucket(
    grouped,
    "node_filesystem_size_bytes",
    (l) => l.mountpoint === "/",
  );
  const availRoot = gaugeMapByBucket(
    grouped,
    "node_filesystem_avail_bytes",
    (l) => l.mountpoint === "/",
  );
  const sizeData = gaugeMapByBucket(
    grouped,
    "node_filesystem_size_bytes",
    (l) => l.mountpoint != null && l.mountpoint !== "/",
  );
  const availData = gaugeMapByBucket(
    grouped,
    "node_filesystem_avail_bytes",
    (l) => l.mountpoint != null && l.mountpoint !== "/",
  );

  // I/O balance: rate of reads vs writes — emit a percentage that's
  // 50 when balanced; null when neither is happening.
  const reads = aggregateRateAcrossLabels(grouped, "node_disk_reads_completed_total");
  const writes = aggregateRateAcrossLabels(grouped, "node_disk_writes_completed_total");

  return buckets.map((t) => {
    const sr = sizeRoot.get(t) ?? 0;
    const ar = availRoot.get(t) ?? 0;
    const sd = sizeData.get(t) ?? 0;
    const ad = availData.get(t) ?? 0;
    const r = reads.get(t) ?? 0;
    const w = writes.get(t) ?? 0;
    const ioTotal = r + w;
    return {
      t,
      rootUsedPct: sr > 0 ? clampPct(100 * (1 - ar / sr)) : 0,
      dataUsedPct: sd > 0 ? clampPct(100 * (1 - ad / sd)) : 0,
      ioBalancePct: ioTotal > 0 ? (r / ioTotal) * 100 : null,
    };
  });
}

function buildReplicationLagSeries(
  grouped: Map<string, Map<string, RawSample[]>>,
  buckets: string[],
): ReplicationLagPoint[] {
  const lag = gaugeMapByBucket(grouped, "replication_realtime_lag_bytes");
  return buckets.map((t) => ({ t, bytes: lag.has(t) ? lag.get(t) ?? 0 : null }));
}

// Loud-when-empty diagnostic; keeps the logger import live so eslint
// doesn't complain when no failure path fires.
void logger;
