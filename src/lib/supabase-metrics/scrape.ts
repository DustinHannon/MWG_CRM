import "server-only";

import { KEEP_LABELS, METRIC_ALLOWLIST } from "./allowlist";
import { parsePrometheusText, type ParseResult } from "./parser";

/**
 * Pure scrape pipeline: fetch the Supabase Prometheus endpoint, parse
 * the text exposition, filter to the allowlist, and shape rows for
 * insert. Separated from the cron route handler so the logic is unit-
 * exercisable from a `.tmp/` smoke script without touching the DB.
 *
 * Every error path returns a tagged failure result instead of throwing.
 * The cron route handler is the only place that decides what HTTP
 * status / log event to emit.
 */

export interface ScrapeRow {
  time: Date;
  metricName: string;
  labels: Record<string, string>;
  value: number;
}

export type ScrapeFetchResult =
  | { ok: true; body: string }
  | { ok: false; cause: "env_missing"; hasProjectRef: boolean; hasSecret: boolean }
  | { ok: false; cause: "timeout" }
  | { ok: false; cause: "network"; message: string }
  | { ok: false; cause: "upstream_error"; status: number };

export interface ScrapePipelineResult {
  asOf: Date;
  parsed: ParseResult;
  rows: ScrapeRow[];
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch the metrics endpoint with timeout + Basic Auth. Returns a
 * tagged result so the caller can log the right structured event.
 *
 * NOTE: the function reads env vars at call time, not at module
 * import time. This preserves the §3.2 no-import-time-side-effects
 * contract — importing this module from any other code path cannot
 * trigger env validation or crash a boot.
 */
export async function fetchMetricsBody(opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ScrapeFetchResult> {
  const projectRef = process.env.SUPABASE_METRICS_PROJECT_REF;
  const secret = process.env.SUPABASE_METRICS_SECRET;
  if (!projectRef || !secret) {
    return {
      ok: false,
      cause: "env_missing",
      hasProjectRef: Boolean(projectRef),
      hasSecret: Boolean(secret),
    };
  }

  const url = `https://${projectRef}.supabase.co/customer/v1/privileged/metrics`;
  const authHeader = `Basic ${Buffer.from(`service_role:${secret}`, "utf8").toString("base64")}`;

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Propagate caller's signal if provided.
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: authHeader, accept: "text/plain" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, cause: "upstream_error", status: res.status };
    }
    const body = await res.text();
    return { ok: true, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, cause: "timeout" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, cause: "network", message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Filter parsed samples by the allowlist and shape them for insert.
 * Strips labels not in KEEP_LABELS so the jsonb column stays bounded.
 * Non-finite samples (NaN/±Inf) are skipped entirely — the bucket is
 * left as a true gap rather than zero-filled. Storing 0 would lie:
 * a +Inf (e.g. a stalled replication slot's lag) would read as
 * "healthy", and a 0 after positive values looks like a counter reset
 * to the downstream rate computation.
 */
export function shapeRowsForInsert(
  parsed: ParseResult,
  asOf: Date,
): ScrapeRow[] {
  const rows: ScrapeRow[] = [];
  for (const s of parsed.samples) {
    if (!METRIC_ALLOWLIST.has(s.name)) continue;
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.labels)) {
      if (KEEP_LABELS.has(k)) kept[k] = v;
    }
    if (!Number.isFinite(s.value)) continue;
    rows.push({
      time: asOf,
      metricName: s.name,
      labels: kept,
      value: s.value,
    });
  }
  return rows;
}

/**
 * Full pipeline: fetch + parse + shape. The cron route handler glues
 * this together with structured logging + DB insert; smoke scripts can
 * call this directly to dry-run a scrape locally.
 */
export async function runScrapePipeline(opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; pipeline: ScrapePipelineResult }
  | { ok: false; cause: "fetch"; detail: Exclude<ScrapeFetchResult, { ok: true }> }
  | { ok: false; cause: "parse"; message: string }
> {
  const asOf = new Date();
  const fetchResult = await fetchMetricsBody(opts);
  if (!fetchResult.ok) {
    return { ok: false, cause: "fetch", detail: fetchResult };
  }

  let parsed: ParseResult;
  try {
    parsed = parsePrometheusText(fetchResult.body);
  } catch (err) {
    return {
      ok: false,
      cause: "parse",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const rows = shapeRowsForInsert(parsed, asOf);
  return { ok: true, pipeline: { asOf, parsed, rows } };
}
