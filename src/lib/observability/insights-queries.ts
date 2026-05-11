import "server-only";

import {
  queryBetterStack,
  betterStackLogsCollection,
  betterStackS3Collection,
} from "./betterstack";

/**
 * Phase 26 §4 — typed Better Stack query functions for the
 * /admin/insights dashboard. Every panel on the page has a single
 * exported function here. All queries flow through `queryBetterStack`
 * so that:
 *   - Auth, transport, and JSONEachRow parsing are centralised.
 *   - Results are wrapped in `unstable_cache` keyed on the panel name.
 *   - Failures emit a `observability.insights.query.failed` system
 *     audit and surface as `BetterStackQueryError`.
 *
 * Schema notes (verified from Better Stack source `mwg_crm`):
 *   raw.vercel.proxy.path        Nullable(String)
 *   raw.vercel.proxy.status_code Nullable(Int64)
 *   raw.vercel.proxy.method      Nullable(String)
 *   raw.vercel.proxy.region      Nullable(String)   // execution region
 *   raw.vercel.proxy.referer     Nullable(String)
 *   raw.vercel.proxy.user_agent  Array(Nullable(String))
 *   raw.vercel.proxy.client_ip   Nullable(String)
 *   raw.vercel.source            Nullable(String)
 *   raw.vercel.level             Nullable(String)
 *   raw.vercel.projectName       Nullable(String)
 *   raw.message                  Nullable(String)
 *   dt                           DateTime
 *
 * Hot collection covers the last ~30 minutes. Anything older needs
 * `s3Cluster(primary, <s3>) WHERE _row_type = 1` UNION'd in.
 */

const HOT = betterStackLogsCollection();
const COLD = betterStackS3Collection();

// JSONExtract aliases used across multiple queries.
const PATH = `JSONExtract(raw, 'vercel', 'proxy', 'path', 'Nullable(String)')`;
const STATUS = `JSONExtract(raw, 'vercel', 'proxy', 'status_code', 'Nullable(Int64)')`;
const REFERER = `JSONExtract(raw, 'vercel', 'proxy', 'referer', 'Nullable(String)')`;
const SOURCE = `JSONExtract(raw, 'vercel', 'source', 'Nullable(String)')`;

/** Source predicate to limit to user-facing HTTP traffic. */
const PROXY_ROWS = `${SOURCE} IN ('lambda', 'edge', 'static', 'external')`;

/** Path filter — exclude api, _next, favicon, blocked landing, static assets. */
const PUBLIC_PATH_FILTER = `${PATH} IS NOT NULL
  AND ${PATH} NOT LIKE '/api/%'
  AND ${PATH} NOT LIKE '/_next/%'
  AND ${PATH} NOT LIKE '/favicon%'
  AND ${PATH} != '/robots.txt'
  AND ${PATH} != '/sitemap.xml'`;

// ----------------------------------------------------------------------------
// KPI cards
// ----------------------------------------------------------------------------

export interface KpiSnapshot {
  /** Total request rows in the last 24h. */
  requestsLast24h: number;
  /** Total request rows in the prior 24h (hour 25..48). */
  requestsPrior24h: number;
  /** Page-view request count (excludes /api/*, /_next/*, /favicon*). */
  pageViewsLast24h: number;
  /** Page-view request count for the prior 24h window. */
  pageViewsPrior24h: number;
  /** % of requests with status_code >= 500 in last 24h. */
  errorRateLast24h: number;
  /** Same for prior 24h, used for delta. */
  errorRatePrior24h: number;
}

interface KpiRow {
  bucket: string;
  total: string;
  page_views: string;
  errors: string;
}

export async function getKpiSnapshot(): Promise<KpiSnapshot> {
  const query = `
    SELECT
      bucket,
      sum(total)      AS total,
      sum(page_views) AS page_views,
      sum(errors)     AS errors
    FROM (
      SELECT
        if(dt >= now() - INTERVAL 24 HOUR, 'last', 'prior') AS bucket,
        count(*) AS total,
        countIf(${PUBLIC_PATH_FILTER}) AS page_views,
        countIf(${STATUS} >= 500) AS errors
      FROM ${HOT}
      WHERE dt >= now() - INTERVAL 48 HOUR
        AND ${PROXY_ROWS}
      GROUP BY bucket
      UNION ALL
      SELECT
        if(dt >= now() - INTERVAL 24 HOUR, 'last', 'prior') AS bucket,
        count(*) AS total,
        countIf(${PUBLIC_PATH_FILTER}) AS page_views,
        countIf(${STATUS} >= 500) AS errors
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 48 HOUR
        AND dt <  now() - INTERVAL 30 MINUTE
        AND ${PROXY_ROWS}
      GROUP BY bucket
    )
    GROUP BY bucket
    ORDER BY bucket
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<KpiRow>({
    query,
    cacheKey: "kpi-snapshot",
  });
  const last = rows.find((r) => r.bucket === "last");
  const prior = rows.find((r) => r.bucket === "prior");
  const lastTotal = Number(last?.total ?? 0);
  const priorTotal = Number(prior?.total ?? 0);
  return {
    requestsLast24h: lastTotal,
    requestsPrior24h: priorTotal,
    pageViewsLast24h: Number(last?.page_views ?? 0),
    pageViewsPrior24h: Number(prior?.page_views ?? 0),
    errorRateLast24h: lastTotal > 0 ? Number(last?.errors ?? 0) / lastTotal : 0,
    errorRatePrior24h:
      priorTotal > 0 ? Number(prior?.errors ?? 0) / priorTotal : 0,
  };
}

// ----------------------------------------------------------------------------
// Traffic timeline (daily request count, last 7 days)
// ----------------------------------------------------------------------------

export interface TrafficDay {
  day: string; // ISO date YYYY-MM-DD
  requests: number;
}

interface TrafficRow {
  day: string;
  requests: string;
}

export async function getTrafficTimeline(): Promise<TrafficDay[]> {
  const query = `
    SELECT
      toString(toDate(day)) AS day,
      sum(requests)         AS requests
    FROM (
      SELECT toStartOfDay(dt) AS day, count(*) AS requests
      FROM ${HOT}
      WHERE dt >= now() - INTERVAL 7 DAY
        AND ${PROXY_ROWS}
      GROUP BY day
      UNION ALL
      SELECT toStartOfDay(dt) AS day, count(*) AS requests
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 7 DAY
        AND dt <  now() - INTERVAL 30 MINUTE
        AND ${PROXY_ROWS}
      GROUP BY day
    )
    GROUP BY day
    ORDER BY day
    LIMIT 14
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<TrafficRow>({
    query,
    cacheKey: "traffic-timeline",
  });
  return rows.map((r) => ({ day: r.day, requests: Number(r.requests) }));
}

// ----------------------------------------------------------------------------
// Top pages (top 10 paths by request count, last 24h)
// ----------------------------------------------------------------------------

export interface TopPageRow {
  path: string;
  requests: number;
}

interface TopPageRaw {
  path: string;
  requests: string;
}

export async function getTopPages(): Promise<TopPageRow[]> {
  const query = `
    SELECT path, sum(requests) AS requests
    FROM (
      SELECT ${PATH} AS path, count(*) AS requests
      FROM ${HOT}
      WHERE dt >= now() - INTERVAL 24 HOUR
        AND ${PROXY_ROWS}
        AND ${PUBLIC_PATH_FILTER}
      GROUP BY path
      UNION ALL
      SELECT ${PATH} AS path, count(*) AS requests
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 24 HOUR
        AND dt <  now() - INTERVAL 30 MINUTE
        AND ${PROXY_ROWS}
        AND ${PUBLIC_PATH_FILTER}
      GROUP BY path
    )
    GROUP BY path
    ORDER BY requests DESC
    LIMIT 10
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<TopPageRaw>({
    query,
    cacheKey: "top-pages",
  });
  return rows.map((r) => ({ path: r.path, requests: Number(r.requests) }));
}

// ----------------------------------------------------------------------------
// Top referrers (top 10 referers, last 24h)
// ----------------------------------------------------------------------------

export interface TopReferrerRow {
  referer: string;
  requests: number;
}

interface TopReferrerRaw {
  referer: string;
  requests: string;
}

export async function getTopReferrers(): Promise<TopReferrerRow[]> {
  const query = `
    SELECT referer, sum(requests) AS requests
    FROM (
      SELECT ${REFERER} AS referer, count(*) AS requests
      FROM ${HOT}
      WHERE dt >= now() - INTERVAL 24 HOUR
        AND ${PROXY_ROWS}
        AND ${REFERER} IS NOT NULL
        AND ${REFERER} != ''
      GROUP BY referer
      UNION ALL
      SELECT ${REFERER} AS referer, count(*) AS requests
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 24 HOUR
        AND dt <  now() - INTERVAL 30 MINUTE
        AND ${PROXY_ROWS}
        AND ${REFERER} IS NOT NULL
        AND ${REFERER} != ''
      GROUP BY referer
    )
    GROUP BY referer
    ORDER BY requests DESC
    LIMIT 10
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<TopReferrerRaw>({
    query,
    cacheKey: "top-referrers",
  });
  return rows.map((r) => ({ referer: r.referer, requests: Number(r.requests) }));
}

// ----------------------------------------------------------------------------
// Visitors by country — REQUIRES Web Analytics drain (not configured today).
// Returns empty array; the panel falls through to <StandardEmptyState />.
// ----------------------------------------------------------------------------

export async function getVisitorsByCountry(): Promise<
  Record<string, number>
> {
  // Today's drain captures runtime logs only — no visitor-country
  // payloads exist in the source. Return an empty record so the
  // panel renders the documented "drain not configured" empty state.
  return {};
}

// ----------------------------------------------------------------------------
// Issues banner — error-rate spike, WAF surge, deployment health
// ----------------------------------------------------------------------------

export interface IssueEntry {
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
}

interface ErrorRateRow {
  bucket: string;
  total: string;
  errors: string;
}

/**
 * Detect error-rate spikes against the 7-day-per-hour baseline.
 * Returns the issue list contribution for the banner. Combined with
 * the WAF and deployment checks in the page component.
 */
export async function getErrorRateIssues(): Promise<IssueEntry[]> {
  const query = `
    SELECT
      bucket,
      sum(total)  AS total,
      sum(errors) AS errors
    FROM (
      SELECT
        if(dt >= now() - INTERVAL 1 HOUR, 'last_hour', 'baseline_7d') AS bucket,
        count(*) AS total,
        countIf(${STATUS} >= 500) AS errors
      FROM ${HOT}
      WHERE dt >= now() - INTERVAL 7 DAY
        AND ${PROXY_ROWS}
      GROUP BY bucket
      UNION ALL
      SELECT
        'baseline_7d' AS bucket,
        count(*) AS total,
        countIf(${STATUS} >= 500) AS errors
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 7 DAY
        AND dt <  now() - INTERVAL 30 MINUTE
        AND ${PROXY_ROWS}
      GROUP BY bucket
    )
    GROUP BY bucket
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<ErrorRateRow>({
    query,
    cacheKey: "error-rate-issues",
  });
  const lastHour = rows.find((r) => r.bucket === "last_hour");
  const baseline = rows.find((r) => r.bucket === "baseline_7d");
  const lastTotal = Number(lastHour?.total ?? 0);
  const lastErrors = Number(lastHour?.errors ?? 0);
  const baseTotal = Number(baseline?.total ?? 0);
  const baseErrors = Number(baseline?.errors ?? 0);
  const issues: IssueEntry[] = [];
  if (lastTotal === 0) return issues;
  const lastRate = lastErrors / lastTotal;
  // 7-day baseline as per-hour rate.
  const baseRate = baseTotal > 0 ? baseErrors / baseTotal : 0;
  if (lastRate > 0.05) {
    issues.push({
      severity: "critical",
      title: "Elevated error rate",
      description: `Last hour: ${(lastRate * 100).toFixed(1)}% 5xx (${lastErrors} of ${lastTotal} requests). Baseline 7d: ${(baseRate * 100).toFixed(2)}%.`,
    });
  } else if (baseRate > 0 && lastRate > baseRate * 10) {
    issues.push({
      severity: "critical",
      title: "Error rate 10x baseline",
      description: `Last hour: ${(lastRate * 100).toFixed(2)}% vs baseline ${(baseRate * 100).toFixed(2)}%.`,
    });
  } else if (baseRate > 0 && lastRate > baseRate * 3) {
    issues.push({
      severity: "warning",
      title: "Error rate above baseline",
      description: `Last hour: ${(lastRate * 100).toFixed(2)}% vs baseline ${(baseRate * 100).toFixed(2)}%.`,
    });
  }
  return issues;
}
