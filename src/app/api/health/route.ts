import "server-only";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { writeSystemAudit } from "@/lib/audit";
import { getGraphAppToken, isGraphAppConfigured } from "@/lib/email/graph-app-token";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * public health-check endpoint.
 *
 * Probes the three dependencies the app cannot function without:
 * 1. Postgres (Supabase / Supavisor) — DB-backed everything.
 * 2. Microsoft Graph token — email sending, lead-activity, contact photos.
 * 3. Vercel Blob — attachments, generated reports, contact photos.
 *
 * Each probe is bounded with its own catch so a single failure tags
 * exactly the dependency that broke, not the whole probe.
 *
 * Response shape (public, sanitized):
 * { healthy: boolean, checks: { db, graph, blob } } where each check is
 * { ok, durationMs, code? } — `code` is a coarse non-sensitive bucket
 * ("unreachable"/"timeout"/"unauthorized"/...). Raw driver error text is
 * never returned to callers (this endpoint is public); it is retained
 * server-side for the audit row + logger.warn only.
 * Status:
 * 200 when every check passes.
 * 503 when any check fails (load balancers / uptime monitors will
 * surface the outage even if the page itself still loads).
 *
 * Result is cached in-process for HEALTH_CHECK_CACHE_TTL_SECONDS so a
 * rapid uptime-monitor probe loop doesn't hammer Graph or Blob. The
 * cache is per-lambda-instance — a healthy result on one instance and
 * a degraded result on another (during a partial dep outage) is fine,
 * both data points are useful.
 *
 * The endpoint is public — already covered by /auth/ and /api/cron/
 * bypass list in src/proxy.ts because `/api/` paths fall through to
 * the auth-cookie check, but `/api/v1/` and other auth-free routes
 * are exempted explicitly. /api/health is added to the public list
 * in proxy.ts so an external monitor can hit it without a session.
 */

// NaN guard on the env-parsed TTL.
// Bad input (`"abc"`) used to silently produce NaN → cache never hits
// → external monitor probe storms hammer Graph + Blob every request.
// Falls back to 30s on any non-finite / negative value.
const PARSED_TTL_SECONDS = Number(
  process.env.HEALTH_CHECK_CACHE_TTL_SECONDS ?? 30,
);
const CACHE_TTL_MS =
  (Number.isFinite(PARSED_TTL_SECONDS) && PARSED_TTL_SECONDS >= 0
    ? PARSED_TTL_SECONDS
    : 30) * 1000;
const PROBE_TIMEOUT_MS = 5000;

interface CheckResult {
  ok: boolean;
  durationMs: number;
  // Coarse, non-sensitive status code for the public response body
  // (e.g. "unreachable", "timeout"). Never the raw driver message.
  code?: string;
  // Raw underlying error message. Server-side only — kept for the
  // logger.warn + writeSystemAudit emission, stripped before the
  // response is serialized (see toPublicResult). Do NOT return this
  // to anonymous callers: postgres-js/Graph/Blob messages embed
  // host/port/role/tenant detail that aids reconnaissance on the one
  // deliberately public endpoint.
  error?: string;
}

interface HealthResult {
  healthy: boolean;
  checks: {
    db: CheckResult;
    graph: CheckResult;
    blob: CheckResult;
  };
  cachedAt: number;
  ttlMs: number;
}

let cache: { result: HealthResult; expiresAt: number } | null = null;

/**
 * Map a raw probe error to a coarse, non-sensitive code for the public
 * response body. The raw message (host/port/role/tenant/OAuth detail)
 * stays server-side only; the public caller gets a stable bucket.
 */
function classifyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("ehostunreach") ||
    lower.includes("getaddrinfo") ||
    lower.includes("connect")
  ) {
    return "unreachable";
  }
  if (
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission") ||
    lower.includes("aadsts") ||
    lower.includes("token")
  ) {
    return "unauthorized";
  }
  return "unavailable";
}

/**
 * Strip the server-only `error` field from every check, leaving only
 * { ok, durationMs, code }. This is the only shape that may reach an
 * unauthenticated caller — the raw `error` is retained on the cached
 * HealthResult for the audit/log path but never serialized to the body.
 */
function toPublicResult(result: HealthResult): HealthResult {
  const stripError = (c: CheckResult): CheckResult => ({
    ok: c.ok,
    durationMs: c.durationMs,
    ...(c.code ? { code: c.code } : {}),
  });
  return {
    ...result,
    checks: {
      db: stripError(result.checks.db),
      graph: stripError(result.checks.graph),
      blob: stripError(result.checks.blob),
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDb(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // `withTimeout` (Promise.race) only races the JS promise; the
    // underlying query keeps running until completion, so under a
    // sustained DB hang it can leak a connection from the Supavisor
    // max:1 pool. Setting `statement_timeout` server-side lets Postgres
    // cancel the query so the connection is released. `SET LOCAL` /
    // `set_config(..., true)` only scope to a transaction, so the
    // timeout-set and the probe SELECT must run in the SAME tx — the
    // canonical pattern used across the codebase (audit-cursor.ts,
    // api-usage-cursor.ts, supabase-metrics queries, admin export
    // routes). The outer `withTimeout` still bounds the case
    // statement_timeout cannot cover: connection acquisition against a
    // wedged Supavisor backend.
    await withTimeout(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('statement_timeout', '5s', true)`,
        );
        await tx.execute(sql`SELECT 1`);
      }),
      PROBE_TIMEOUT_MS + 500,
      "db",
    );
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      durationMs: Date.now() - start,
      code: classifyError(message),
      error: message,
    };
  }
}

async function checkGraph(): Promise<CheckResult> {
  const start = Date.now();
  try {
    if (!isGraphAppConfigured()) {
      // Treat unconfigured as a degraded state: outbound email is dead.
      // ENTRA_NOT_CONFIGURED is a deliberate non-sensitive public signal.
      return {
        ok: false,
        durationMs: Date.now() - start,
        code: "not_configured",
        error: "ENTRA_NOT_CONFIGURED",
      };
    }
    // getGraphAppToken caches internally + has retry from §4.4. The
    // health check should not force a refresh, so this is usually
    // a cache hit returning in <1ms.
    await withTimeout(getGraphAppToken(), PROBE_TIMEOUT_MS, "graph");
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      durationMs: Date.now() - start,
      code: classifyError(message),
      error: message,
    };
  }
}

async function checkBlob(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Exercises Vercel Blob auth + connectivity without depending on a
    // specific canary blob existing. `list({ limit: 1 })` is bounded,
    // cheap, and returns even when the store is empty.
    const { list } = await import("@vercel/blob");
    await withTimeout(list({ limit: 1 }), PROBE_TIMEOUT_MS, "blob");
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      durationMs: Date.now() - start,
      code: classifyError(message),
      error: message,
    };
  }
}

async function checkAll(): Promise<HealthResult> {
  const [dbResult, graphResult, blobResult] = await Promise.all([
    checkDb(),
    checkGraph(),
    checkBlob(),
  ]);
  return {
    healthy: dbResult.ok && graphResult.ok && blobResult.ok,
    checks: { db: dbResult, graph: graphResult, blob: blobResult },
    cachedAt: Date.now(),
    ttlMs: CACHE_TTL_MS,
  };
}

export async function GET() {
  if (cache && Date.now() < cache.expiresAt) {
    // Serialize the sanitized view only — the cached result keeps raw
    // `error` strings for the server-side audit/log path, never the body.
    return NextResponse.json(toPublicResult(cache.result), {
      status: cache.result.healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const result = await checkAll();
  cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };

  if (!result.healthy) {
    // Emit a single audit row per cache-miss probe (not per request) so
    // the audit log records *transitions* into degraded state rather
    // than every cached re-read.
    const degraded = Object.entries(result.checks)
      .filter(([, c]) => !c.ok)
      .map(([name, c]) => ({ name, error: c.error, durationMs: c.durationMs }));
    await writeSystemAudit({
      actorEmailSnapshot: "system@health",
      action: "api_health.degraded",
      targetType: "system_health",
      after: { degraded },
    });
    logger.warn("api_health.degraded", { degraded });
  }

  // Return the sanitized view — raw per-check `error` strings are kept
  // only in the cached result for the audit/log emission above.
  return NextResponse.json(toPublicResult(result), {
    status: result.healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
