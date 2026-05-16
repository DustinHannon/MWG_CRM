import "server-only";

import { unstable_cache } from "next/cache";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { writeSystemAudit } from "@/lib/audit";

/**
 * Better Stack SQL Query API client. Shared by
 * /admin/insights (Sub-agent A) and /admin/server-metrics (Sub-agent B).
 *
 * Auth: HTTP Basic with env.BETTERSTACK_QUERY_USERNAME +
 * env.BETTERSTACK_QUERY_PASSWORD. Source resolved via
 * env.BETTERSTACK_TEAM_ID + env.BETTERSTACK_SOURCE_ID (the
 * ClickHouse collection name is `t<team>_<source-slug>_logs`; the
 * source slug for mwg-crm is `mwg_crm`).
 *
 * Output format: JSONEachRow (one JSON object per line). The wrapper
 * parses each line into a typed row.
 *
 * Caching: results are wrapped in Next.js `unstable_cache` keyed on
 * the SQL string + the cacheKey caller supplies. TTL defaults to
 * env.INSIGHTS_CACHE_TTL_SECONDS. Pages use `revalidatePath` to
 * bypass when the user clicks "Refresh".
 */

export interface BetterStackQueryOptions {
  /** ClickHouse-flavored SQL. The collection name is interpolated
   * via the helpers below (`betterStackLogsCollection`,
   * `betterStackS3Collection`) — never hardcode `t<id>_..._logs`. */
  query: string;
  /** Cache key fragment — usually the panel name. */
  cacheKey: string;
  /** Cache TTL override in seconds. Default INSIGHTS_CACHE_TTL_SECONDS. */
  cacheTtlSeconds?: number;
  /** Audit-event family for failures, e.g. "observability.insights" */
  auditFamily?: "observability.insights" | "observability.server_logs";
}

export class BetterStackNotConfiguredError extends Error {
  constructor() {
    super(
      "Better Stack SQL Query API is not configured. See operations docs.",
    );
    this.name = "BetterStackNotConfiguredError";
  }
}

export class BetterStackQueryError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "BetterStackQueryError";
  }
}

/** True when every required Better Stack env var is populated. */
export function isBetterStackConfigured(): boolean {
  return Boolean(
    env.BETTERSTACK_SOURCE_ID &&
      env.BETTERSTACK_TEAM_ID &&
      env.BETTERSTACK_QUERY_HOST &&
      env.BETTERSTACK_QUERY_USERNAME &&
      env.BETTERSTACK_QUERY_PASSWORD,
  );
}

/** ClickHouse collection name for hot/recent logs (last ~30 minutes). */
export function betterStackLogsCollection(sourceSlug = "mwg_crm"): string {
  return `t${env.BETTERSTACK_TEAM_ID}_${sourceSlug}_logs`;
}

/** ClickHouse collection name for historical/cold logs (older than ~30 minutes). */
export function betterStackS3Collection(sourceSlug = "mwg_crm"): string {
  return `t${env.BETTERSTACK_TEAM_ID}_${sourceSlug}_s3`;
}

/**
 * Process-local concurrency limiter. Better Stack's Standard plan
 * caps logs queries at 4 concurrent per user. The Insights page
 * issues 5–6 panel queries via Suspense streaming; without a limiter
 * we hit HTTP 429. Cap at 3 to leave headroom for any other panel
 * (e.g., Server Metrics page rendering in the same render pass).
 *
 * Semaphore is per-Node-process. Fluid Compute reuses instances, so
 * the queue persists across requests on the same worker — desirable
 * since the rate limit is also per-user, not per-request.
 */
const BETTERSTACK_MAX_CONCURRENCY = 3;

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const bsLimiter = new AsyncSemaphore(BETTERSTACK_MAX_CONCURRENCY);

async function executeQuery<TRow>(
  query: string,
  auditFamily: "observability.insights" | "observability.server_logs",
): Promise<TRow[]> {
  if (!isBetterStackConfigured()) {
    throw new BetterStackNotConfiguredError();
  }

  await bsLimiter.acquire();
  try {
    return await executeQueryInner<TRow>(query, auditFamily);
  } finally {
    bsLimiter.release();
  }
}

async function executeQueryInner<TRow>(
  query: string,
  auditFamily: "observability.insights" | "observability.server_logs",
): Promise<TRow[]> {
  const url = `https://${env.BETTERSTACK_QUERY_HOST}?output_format_pretty_row_numbers=0`;
  const auth = Buffer.from(
    `${env.BETTERSTACK_QUERY_USERNAME}:${env.BETTERSTACK_QUERY_PASSWORD}`,
  ).toString("base64");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "text/plain",
      },
      body: query,
      // Force fresh data on every server-side call; `unstable_cache`
      // is what gives us the TTL window above this layer.
      cache: "no-store",
    });
  } catch (err) {
    await emitFailureAudit(auditFamily, query, "fetch_failed", err);
    throw new BetterStackQueryError(
      `Better Stack fetch failed: ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    await emitFailureAudit(
      auditFamily,
      query,
      `http_${response.status}`,
      new Error(text.slice(0, 500)),
    );
    throw new BetterStackQueryError(
      `Better Stack ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    );
  }

  const text = await response.text();
  // JSONEachRow returns one JSON object per line. Empty result = empty body.
  if (!text.trim()) return [];

  const rows: TRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as TRow);
    } catch {
      // Skip non-JSON lines (defensive — ClickHouse should be strict).
      logger.warn("betterstack.parse_warning", {
        line: trimmed.slice(0, 200),
      });
    }
  }
  return rows;
}

async function emitFailureAudit(
  auditFamily: "observability.insights" | "observability.server_logs",
  query: string,
  kind: string,
  err: unknown,
): Promise<void> {
  try {
    await writeSystemAudit({
      actorEmailSnapshot: "system@observability",
      action: `${auditFamily}.query.failed`,
      targetType: "betterstack_query",
      after: {
        kind,
        query_excerpt: query.slice(0, 300),
        message: (err as Error)?.message?.slice(0, 500) ?? "unknown",
      },
    });
  } catch {
    // Audit failures must never block the caller's error path.
  }
}

/**
 * Execute a Better Stack SQL query with server-side caching.
 *
 * Append `FORMAT JSONEachRow` to your query — the helper expects that
 * shape. ClickHouse rejects a duplicate FORMAT clause, so the helper
 * does NOT auto-append.
 */
export async function queryBetterStack<TRow>(
  opts: BetterStackQueryOptions,
): Promise<TRow[]> {
  const ttl = opts.cacheTtlSeconds ?? env.INSIGHTS_CACHE_TTL_SECONDS;
  const auditFamily = opts.auditFamily ?? "observability.insights";

  const fn = unstable_cache(
    async () => executeQuery<TRow>(opts.query, auditFamily),
    ["betterstack", auditFamily, opts.cacheKey],
    { revalidate: ttl, tags: ["betterstack", auditFamily] },
  );

  return fn();
}
