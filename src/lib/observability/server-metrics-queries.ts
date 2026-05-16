import "server-only";

import {
  betterStackLogsCollection,
  betterStackS3Collection,
  isBetterStackConfigured,
  queryBetterStack,
} from "@/lib/observability/betterstack";

/**
 * Aggregated telemetry queries for /admin/server-metrics.
 *
 * Each panel has one exported function. Every function:
 * Validates configuration via `isBetterStackConfigured` (the
 * wrapper throws `BetterStackNotConfiguredError` otherwise; we
 * re-check at the boundary so the page can render a typed empty
 * state without a try/catch dance).
 * Picks the collection mix based on the requested time range:
 * 1h → hot collection only (sub-30-minute drain)
 * 6h → UNION ALL hot + s3 (overlap is fine; ClickHouse counts
 * each event once per row, and the s3 collection has a
 * `_row_type = 1` filter that excludes meta rows)
 * 24h → UNION ALL hot + s3
 * 7d → s3 only (hot doesn't cover that window; using s3 alone
 * avoids paying the UNION cost on a 7-day scan)
 * Passes `auditFamily: "observability.server_logs"` so any query
 * failure audits under the right family.
 *
 * NOT a raw log tail. The /admin/server-metrics page surfaces aggregated
 * views only per the brief §5.
 */

export type ServerMetricsRange = "1h" | "6h" | "24h" | "7d";

const RANGE_TO_INTERVAL: Record<ServerMetricsRange, string> = {
  "1h": "INTERVAL 1 HOUR",
  "6h": "INTERVAL 6 HOUR",
  "24h": "INTERVAL 24 HOUR",
  "7d": "INTERVAL 7 DAY",
};

/**
 * Build the FROM clause for a given range. The result is a SQL
 * fragment that can be substituted into a larger query. Hot data lives
 * in `betterStackLogsCollection()`; cold data in `betterStackS3Collection()`
 * which requires the `_row_type = 1` predicate per Better Stack's
 * recommendation.
 */
function buildFromClause(range: ServerMetricsRange): string {
  const hot = betterStackLogsCollection();
  const cold = betterStackS3Collection();

  if (range === "1h") {
    return `FROM remote(${hot})`;
  }
  if (range === "7d") {
    return `FROM s3Cluster(primary, ${cold})`;
  }
  // 6h and 24h — UNION ALL hot + cold via a derived subquery so
  // outer aggregations (count/min/max/multiIf) can operate on the
  // combined set. The cold collection needs `_row_type = 1` to skip
  // index metadata rows.
  return `FROM (
    SELECT raw, _pattern, dt FROM remote(${hot})
    UNION ALL
    SELECT raw, _pattern, dt FROM s3Cluster(primary, ${cold}) WHERE _row_type = 1
  )`;
}

/* ============================================================================
 * Panel 1 — Error patterns
 *
 * Group by `_pattern` (ClickHouse's auto-pattern field that strips
 * dynamic IDs/numbers) for log lines where the HTTP status indicates
 * a server-side failure. We anchor on status >= 500 rather than
 * `vercel.level` because the Vercel drain leaves `level` blank or
 * "info" for most error lines. Failures are usually only detectable
 * via the proxy status code.
 * ========================================================================= */

export interface ErrorPatternRow {
  pattern: string | null;
  n: string | number;
  first_seen: string;
  last_seen: string;
  sample: string | null;
}

export async function getErrorPatterns(
  range: ServerMetricsRange,
): Promise<ErrorPatternRow[]> {
  if (!isBetterStackConfigured()) return [];
  const fromClause = buildFromClause(range);
  const interval = RANGE_TO_INTERVAL[range];
  const query = `
    SELECT
      _pattern AS pattern,
      count(*) AS n,
      min(dt) AS first_seen,
      max(dt) AS last_seen,
      any(JSONExtract(raw, 'message', 'Nullable(String)')) AS sample
    ${fromClause}
    WHERE dt > now() - ${interval}
      AND JSONExtract(raw, 'vercel', 'proxy', 'status_code', 'Nullable(Int64)') >= 500
    GROUP BY _pattern
    ORDER BY n DESC
    LIMIT 10
    FORMAT JSONEachRow
  `;
  return queryBetterStack<ErrorPatternRow>({
    query,
    cacheKey: `server-metrics.error-patterns.${range}`,
    auditFamily: "observability.server_logs",
  });
}

/* ============================================================================
 * Panel 2 — Request volume by endpoint
 *
 * Top 20 paths by request count, with a parallel 5xx error count so
 * the UI can compute the error rate. Excludes `/_next/*` and
 * `/favicon*` because the static-asset noise dominates real traffic.
 * ========================================================================= */

export interface RequestVolumeRow {
  path: string | null;
  requests: string | number;
  errors: string | number;
}

export async function getRequestVolume(
  range: ServerMetricsRange,
): Promise<RequestVolumeRow[]> {
  if (!isBetterStackConfigured()) return [];
  const fromClause = buildFromClause(range);
  const interval = RANGE_TO_INTERVAL[range];
  const query = `
    SELECT
      JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)') AS path,
      count(*) AS requests,
      countIf(JSONExtract(raw, 'vercel', 'proxy', 'status_code', 'Nullable(Int64)') >= 500) AS errors
    ${fromClause}
    WHERE dt > now() - ${interval}
      AND JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)') IS NOT NULL
      AND JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)') NOT LIKE '/_next/%'
      AND JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)') NOT LIKE '/favicon%'
    GROUP BY path
    ORDER BY requests DESC
    LIMIT 20
    FORMAT JSONEachRow
  `;
  return queryBetterStack<RequestVolumeRow>({
    query,
    cacheKey: `server-metrics.request-volume.${range}`,
    auditFamily: "observability.server_logs",
  });
}

/* ============================================================================
 * Panel 3 — Status code distribution
 *
 * Bucket every proxy status code into 2xx/3xx/4xx/5xx for the donut.
 * The inner subquery extracts the nullable int once; the outer query
 * filters nulls and zeros (Vercel writes `0` for some Lambda-internal
 * lines that don't represent a real HTTP response).
 * ========================================================================= */

export interface StatusDistributionRow {
  bucket: "2xx" | "3xx" | "4xx" | "5xx";
  n: string | number;
}

export async function getStatusDistribution(
  range: ServerMetricsRange,
): Promise<StatusDistributionRow[]> {
  if (!isBetterStackConfigured()) return [];
  const fromClause = buildFromClause(range);
  const interval = RANGE_TO_INTERVAL[range];
  const query = `
    SELECT
      multiIf(
        status < 300, '2xx',
        status < 400, '3xx',
        status < 500, '4xx',
        '5xx'
      ) AS bucket,
      count(*) AS n
    FROM (
      SELECT JSONExtract(raw, 'vercel', 'proxy', 'status_code', 'Nullable(Int64)') AS status
      ${fromClause}
      WHERE dt > now() - ${interval}
    )
    WHERE status IS NOT NULL AND status > 0
    GROUP BY bucket
    ORDER BY bucket
    FORMAT JSONEachRow
  `;
  return queryBetterStack<StatusDistributionRow>({
    query,
    cacheKey: `server-metrics.status-distribution.${range}`,
    auditFamily: "observability.server_logs",
  });
}

/* ============================================================================
 * Panel 5 — Deploy timeline (errors per 5-minute bucket, last 24h)
 *
 * Always 24h regardless of the page-level range — this panel exists
 * to correlate spikes with deploys, so a fixed window is more useful
 * than the user-selected range. UNION the hot + s3 sources so the
 * trailing 30 minutes are included even though they haven't migrated
 * to s3 yet.
 * ========================================================================= */

export interface DeployTimelineRow {
  bucket: string;
  errors: string | number;
  total: string | number;
}

export async function getDeployTimeline(): Promise<DeployTimelineRow[]> {
  if (!isBetterStackConfigured()) return [];
  // Hard-coded to a 24-hour window — see comment above.
  const fromClause = buildFromClause("24h");
  const query = `
    SELECT
      toStartOfFiveMinute(dt) AS bucket,
      countIf(JSONExtract(raw, 'vercel', 'proxy', 'status_code', 'Nullable(Int64)') >= 500) AS errors,
      count(*) AS total
    ${fromClause}
    WHERE dt > now() - INTERVAL 24 HOUR
    GROUP BY bucket
    ORDER BY bucket
    FORMAT JSONEachRow
  `;
  return queryBetterStack<DeployTimelineRow>({
    query,
    cacheKey: "server-metrics.deploy-timeline.24h",
    auditFamily: "observability.server_logs",
  });
}

/* ============================================================================
 * Panel 4 — Slow endpoints (p95 by path)
 *
 * Vercel's drain writes Lambda invocation duration into the message
 * text rather than a structured field — every invocation logs:
 *
 * START RequestId: <uuid>
 * [METHOD] /path status=NNN
 * END RequestId: <uuid>
 * REPORT RequestId: <uuid> Duration: N ms Billed Duration: N ms ...
 *
 * Importantly, all four lines arrive in ONE log entry's `message`
 * field, so we can extract path (already structured via
 * `vercel.proxy.path`) and duration (regex over message) on the same
 * row without a cross-row join. RSC traffic appends a `?_rsc=...`
 * query string that's stripped here so /dashboard and
 * /dashboard?_rsc=... aggregate together. Static-asset paths are
 * excluded to mirror the request-volume panel.
 * ========================================================================= */

export interface SlowEndpointRow {
  path: string;
  samples: string | number;
  p95_ms: string | number;
  p50_ms: string | number;
  max_ms: string | number;
}

export async function getSlowEndpoints(
  range: ServerMetricsRange,
): Promise<SlowEndpointRow[]> {
  if (!isBetterStackConfigured()) return [];
  const fromClause = buildFromClause(range);
  const interval = RANGE_TO_INTERVAL[range];
  // Inner subquery extracts the regex once per row; outer aggregates.
  // HAVING samples >= 5 keeps p95 statistically meaningful while still
  // surfacing low-volume endpoints on a quiet hour.
  const query = `
    SELECT
      path,
      count(*) AS samples,
      round(quantile(0.95)(duration_ms)) AS p95_ms,
      round(quantile(0.50)(duration_ms)) AS p50_ms,
      max(duration_ms) AS max_ms
    FROM (
      SELECT
        replaceRegexpOne(
          JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)'),
          '\\\\?.*$',
          ''
        ) AS path,
        toUInt32OrZero(
          extract(
            JSONExtract(raw, 'message', 'Nullable(String)'),
            'Duration:[[:space:]]+([0-9]+)[[:space:]]*ms'
          )
        ) AS duration_ms
      ${fromClause}
      WHERE dt > now() - ${interval}
        AND JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%Duration:%'
    )
    WHERE duration_ms > 0
      AND path IS NOT NULL
      AND path != ''
      AND path NOT LIKE '/_next/%'
      AND path NOT LIKE '/favicon%'
    GROUP BY path
    HAVING samples >= 5
    ORDER BY p95_ms DESC
    LIMIT 10
    FORMAT JSONEachRow
  `;
  return queryBetterStack<SlowEndpointRow>({
    query,
    cacheKey: `server-metrics.slow-endpoints.${range}`,
    auditFamily: "observability.server_logs",
  });
}
