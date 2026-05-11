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
// Speed Insights + Analytics drain aliases (Phase 26 follow-up).
// Once the dedicated drains are configured these records flow into the
// SAME Better Stack source as runtime logs; the `vercel.schema` field
// distinguishes them.
// ----------------------------------------------------------------------------
const SCHEMA = `JSONExtract(raw, 'vercel', 'schema', 'Nullable(String)')`;
const SI_FILTER = `${SCHEMA} = 'vercel.speed_insights.v1'`;
const AN_FILTER = `${SCHEMA} = 'vercel.analytics.v1'`;
/** Per-event path on Speed Insights / Analytics drains (NOT proxy.path). */
const SI_PATH = `JSONExtract(raw, 'vercel', 'path', 'Nullable(String)')`;
const SI_METRIC = `JSONExtract(raw, 'vercel', 'metricType', 'Nullable(String)')`;
const SI_VALUE = `JSONExtract(raw, 'vercel', 'value', 'Nullable(Float64)')`;
const COUNTRY = `JSONExtract(raw, 'vercel', 'country', 'Nullable(String)')`;
const AN_EVENT = `JSONExtract(raw, 'vercel', 'eventType', 'Nullable(String)')`;
const DEVICE_ID = `JSONExtract(raw, 'vercel', 'deviceId', 'Nullable(UInt64)')`;

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
  /**
   * p75 LCP / INP / TTFB over the last 24h in ms. `null` when the
   * Speed Insights drain hasn't produced any samples yet (Vercel
   * sampling means a new project can take a few minutes to surface
   * its first metrics).
   */
  p75LcpMs: number | null;
  p75LcpPriorMs: number | null;
  p75InpMs: number | null;
  p75InpPriorMs: number | null;
  /** Median (p50) TTFB — Vercel SI labels this as the primary TTFB metric. */
  medianTtfbMs: number | null;
  medianTtfbPriorMs: number | null;
}

interface KpiRow {
  bucket: string;
  total: string;
  page_views: string;
  errors: string;
}

interface WebVitalKpiRow {
  bucket: string;
  metric: string;
  p75: string | number | null;
  p50: string | number | null;
}

async function getWebVitalKpiRows(): Promise<WebVitalKpiRow[]> {
  // p75 (and p50 for TTFB) over last + prior 24h, grouped by metricType.
  // Speed Insights events are short-lived in hot storage (~30m). For
  // 48h coverage we UNION hot + cold; cold is filtered by `_row_type=1`
  // per Better Stack's S3 schema.
  const query = `
    SELECT
      bucket,
      metric,
      quantile(0.75)(value) AS p75,
      quantile(0.50)(value) AS p50
    FROM (
      SELECT
        if(dt >= now() - INTERVAL 24 HOUR, 'last', 'prior') AS bucket,
        ${SI_METRIC} AS metric,
        ${SI_VALUE} AS value
      FROM remote(${HOT})
      WHERE dt >= now() - INTERVAL 48 HOUR
        AND ${SI_FILTER}
        AND ${SI_VALUE} IS NOT NULL
      UNION ALL
      SELECT
        if(dt >= now() - INTERVAL 24 HOUR, 'last', 'prior') AS bucket,
        ${SI_METRIC} AS metric,
        ${SI_VALUE} AS value
      FROM s3Cluster(primary, ${COLD})
      WHERE _row_type = 1
        AND dt >= now() - INTERVAL 48 HOUR
        AND dt < now() - INTERVAL 30 MINUTE
        AND ${SI_FILTER}
        AND ${SI_VALUE} IS NOT NULL
    )
    WHERE metric IS NOT NULL
    GROUP BY bucket, metric
    FORMAT JSONEachRow
  `;
  try {
    return await queryBetterStack<WebVitalKpiRow>({
      query,
      cacheKey: "kpi-web-vitals",
    });
  } catch {
    // If the SI drain hasn't produced any rows yet (or the schema
    // filter matches zero records) we want a graceful fallback so
    // the request KPIs still render — return empty.
    return [];
  }
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
      FROM remote(${HOT})
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
  const [rows, vitalRows] = await Promise.all([
    queryBetterStack<KpiRow>({ query, cacheKey: "kpi-snapshot" }),
    getWebVitalKpiRows(),
  ]);
  const last = rows.find((r) => r.bucket === "last");
  const prior = rows.find((r) => r.bucket === "prior");
  const lastTotal = Number(last?.total ?? 0);
  const priorTotal = Number(prior?.total ?? 0);

  const pickVital = (
    bucket: "last" | "prior",
    metric: string,
    field: "p75" | "p50" = "p75",
  ): number | null => {
    const row = vitalRows.find(
      (r) => r.bucket === bucket && r.metric === metric,
    );
    if (!row) return null;
    const v = Number(row[field]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  return {
    requestsLast24h: lastTotal,
    requestsPrior24h: priorTotal,
    pageViewsLast24h: Number(last?.page_views ?? 0),
    pageViewsPrior24h: Number(prior?.page_views ?? 0),
    errorRateLast24h: lastTotal > 0 ? Number(last?.errors ?? 0) / lastTotal : 0,
    errorRatePrior24h:
      priorTotal > 0 ? Number(prior?.errors ?? 0) / priorTotal : 0,
    p75LcpMs: pickVital("last", "LCP"),
    p75LcpPriorMs: pickVital("prior", "LCP"),
    p75InpMs: pickVital("last", "INP"),
    p75InpPriorMs: pickVital("prior", "INP"),
    medianTtfbMs: pickVital("last", "TTFB", "p50"),
    medianTtfbPriorMs: pickVital("prior", "TTFB", "p50"),
  };
}

// ----------------------------------------------------------------------------
// Core Web Vitals breakdown (p75 per metric, last 24h)
// ----------------------------------------------------------------------------

export type WebVitalMetric = "LCP" | "FCP" | "CLS" | "INP" | "TTFB";

export interface CoreWebVitalRow {
  metric: WebVitalMetric;
  p75: number;
  samples: number;
}

interface CoreWebVitalQueryRow {
  metric: string;
  p75: string | number;
  samples: string | number;
}

export async function getCoreWebVitals(): Promise<CoreWebVitalRow[]> {
  const query = `
    SELECT
      ${SI_METRIC} AS metric,
      quantile(0.75)(${SI_VALUE}) AS p75,
      count(*) AS samples
    FROM remote(${HOT})
    WHERE dt > now() - INTERVAL 24 HOUR
      AND ${SI_FILTER}
      AND ${SI_VALUE} IS NOT NULL
      AND ${SI_METRIC} IN ('LCP', 'FCP', 'CLS', 'INP', 'TTFB')
    GROUP BY metric
    FORMAT JSONEachRow
  `;
  const rows = await queryBetterStack<CoreWebVitalQueryRow>({
    query,
    cacheKey: "core-web-vitals",
  });
  return rows
    .filter((r): r is CoreWebVitalQueryRow & { metric: WebVitalMetric } =>
      ["LCP", "FCP", "CLS", "INP", "TTFB"].includes(r.metric ?? ""),
    )
    .map((r) => ({
      metric: r.metric as WebVitalMetric,
      p75: Number(r.p75),
      samples: Number(r.samples),
    }))
    .filter((r) => Number.isFinite(r.p75) && r.p75 > 0);
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
      FROM remote(${HOT})
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
      FROM remote(${HOT})
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
      FROM remote(${HOT})
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
// Visitors by country — powered by the Web Analytics drain (Phase 26 follow-up).
// Returns a country-code → unique-visitor-count map keyed by ISO 3166-1
// alpha-2. Falls back to an empty record if the analytics drain hasn't
// produced any samples in the last 24h.
// ----------------------------------------------------------------------------

interface VisitorCountryRow {
  country: string;
  visitors: string | number;
}

export async function getVisitorsByCountry(): Promise<
  Record<string, number>
> {
  const query = `
    SELECT
      ${COUNTRY} AS country,
      uniqExact(${DEVICE_ID}) AS visitors
    FROM remote(${HOT})
    WHERE dt > now() - INTERVAL 24 HOUR
      AND ${AN_FILTER}
      AND ${AN_EVENT} = 'pageview'
      AND ${COUNTRY} IS NOT NULL
      AND ${COUNTRY} != ''
      AND ${DEVICE_ID} IS NOT NULL
    GROUP BY country
    ORDER BY visitors DESC
    FORMAT JSONEachRow
  `;
  let rows: VisitorCountryRow[];
  try {
    rows = await queryBetterStack<VisitorCountryRow>({
      query,
      cacheKey: "visitors-by-country",
    });
  } catch {
    return {};
  }
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.country) continue;
    out[r.country.toUpperCase()] = Number(r.visitors);
  }
  return out;
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
      FROM remote(${HOT})
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
