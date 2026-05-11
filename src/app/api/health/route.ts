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
 * Phase 25 §4.2 — public health-check endpoint.
 *
 * Probes the three dependencies the app cannot function without:
 *   1. Postgres (Supabase / Supavisor) — DB-backed everything.
 *   2. Microsoft Graph token — email sending, lead-activity, contact photos.
 *   3. Vercel Blob — attachments, generated reports, contact photos.
 *
 * Each probe is bounded with its own catch so a single failure tags
 * exactly the dependency that broke, not the whole probe.
 *
 * Response shape:
 *   { healthy: boolean, checks: { db, graph, blob } }
 * Status:
 *   200 when every check passes.
 *   503 when any check fails (load balancers / uptime monitors will
 *   surface the outage even if the page itself still loads).
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

// Phase 25 §4.2 P1 follow-up — NaN guard on the env-parsed TTL.
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
    // Phase 25 §4.2 P1 follow-up — Promise.race only races the
    // promise; the underlying query keeps running until completion,
    // which under sustained DB hang leaks a connection from the
    // Supavisor max:1 pool. Setting `statement_timeout` server-side
    // forces Postgres to cancel the SELECT once 5s elapses so the
    // client connection is actually released.
    await withTimeout(
      db.execute(sql`SET LOCAL statement_timeout = '5s'; SELECT 1`),
      PROBE_TIMEOUT_MS + 500,
      "db",
    );
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkGraph(): Promise<CheckResult> {
  const start = Date.now();
  try {
    if (!isGraphAppConfigured()) {
      // Treat unconfigured as a degraded state: outbound email is dead.
      return {
        ok: false,
        durationMs: Date.now() - start,
        error: "ENTRA_NOT_CONFIGURED",
      };
    }
    // getGraphAppToken caches internally + has retry from §4.4. The
    // health check should not force a refresh, so this is usually
    // a cache hit returning in <1ms.
    await withTimeout(getGraphAppToken(), PROBE_TIMEOUT_MS, "graph");
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
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
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
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
    return NextResponse.json(cache.result, {
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

  return NextResponse.json(result, {
    status: result.healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
