import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { db } from "@/db";
import { supabaseMetrics } from "@/db/schema/supabase-metrics";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import {
  runScrapePipeline,
  type ScrapeRow,
} from "@/lib/supabase-metrics/scrape";

/**
 * Supabase Prometheus metrics scrape — runs once per minute via Vercel
 * Cron. Fetches the Supabase Metrics endpoint with service_role Basic
 * Auth, parses Prometheus text, filters to the allowlist, and bulk-
 * inserts into the `supabase_metrics` time-series table.
 *
 * Configured in vercel.json as:
 *   { "path": "/api/cron/scrape-supabase-metrics", "schedule": "* * * * *" }
 *
 * Failure contract — see CLAUDE.md "Site isolation":
 *   - The handler NEVER throws to the route. The outer try/catch
 *     swallows everything.
 *   - The handler NEVER returns 5xx for transient failures. Vercel
 *     retries 5xx, and the intent here is exactly one attempt per
 *     minute. Transient failures return 200 with `{ ok: false, error }`
 *     and a structured log line.
 *   - Auth failures return 401 from `requireCronAuth` directly (correct
 *     semantic — distinguishes broken cron config from broken scrape).
 *
 * Overlap safety: append-only inserts can't conflict. If a scrape
 * takes > 60s and a second cron lands, both writes succeed with
 * adjacent timestamps. The snapshot query handles duplicates via
 * DISTINCT ON.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Cap inserted rows per run. Defends against an upstream explosion. */
const ROW_CAP = 10_000;

/**
 * Batch insert chunk size. 500 rows × 4 columns = 2000 bound
 * parameters per statement — well under Postgres's 65535 limit and
 * comfortable through Supavisor's transaction pool.
 */
const INSERT_BATCH = 500;

export async function GET(req: Request) {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  const scrapeId = randomUUID();
  const startedAt = Date.now();
  logger.info("supabase_metrics.scrape.started", { scrapeId });

  try {
    const pipeline = await runScrapePipeline();
    if (!pipeline.ok) {
      const durationMs = Date.now() - startedAt;
      if (pipeline.cause === "fetch") {
        const d = pipeline.detail;
        if (d.cause === "env_missing") {
          logger.error("supabase_metrics.scrape.env_missing", {
            scrapeId,
            hasProjectRef: d.hasProjectRef,
            hasSecret: d.hasSecret,
            durationMs,
          });
          return NextResponse.json(
            { ok: false, error: "env_missing" },
            { status: 200 },
          );
        }
        if (d.cause === "timeout") {
          logger.error("supabase_metrics.scrape.fetch_failed", {
            scrapeId,
            cause: "timeout",
            durationMs,
          });
          return NextResponse.json(
            { ok: false, error: "fetch_timeout" },
            { status: 200 },
          );
        }
        if (d.cause === "network") {
          logger.error("supabase_metrics.scrape.fetch_failed", {
            scrapeId,
            cause: "network",
            errorMessage: d.message,
            durationMs,
          });
          return NextResponse.json(
            { ok: false, error: "fetch_network" },
            { status: 200 },
          );
        }
        // upstream_error
        logger.error("supabase_metrics.scrape.fetch_failed", {
          scrapeId,
          cause: "upstream_error",
          upstreamStatus: d.status,
          durationMs,
        });
        return NextResponse.json(
          { ok: false, error: "fetch_failed", status: d.status },
          { status: 200 },
        );
      }
      // parse failure
      logger.error("supabase_metrics.scrape.parse_failed", {
        scrapeId,
        errorMessage: pipeline.message,
        durationMs,
      });
      return NextResponse.json(
        { ok: false, error: "parse_failed" },
        { status: 200 },
      );
    }

    const { asOf, parsed, rows: shapedRows } = pipeline.pipeline;

    // Row cap defense.
    let rows: ScrapeRow[] = shapedRows;
    if (rows.length > ROW_CAP) {
      logger.warn("supabase_metrics.scrape.row_cap_exceeded", {
        scrapeId,
        rowCount: rows.length,
        cap: ROW_CAP,
      });
      rows = rows.slice(0, ROW_CAP);
    }

    // Batch insert.
    let written = 0;
    try {
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const chunk = rows.slice(i, i + INSERT_BATCH);
        if (chunk.length === 0) continue;
        await db.insert(supabaseMetrics).values(chunk);
        written += chunk.length;
      }
    } catch (err) {
      logger.error("supabase_metrics.scrape.insert_failed", {
        scrapeId,
        writtenBeforeFailure: written,
        totalToWrite: rows.length,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { ok: false, error: "insert_failed", written },
        { status: 200 },
      );
    }

    const durationMs = Date.now() - startedAt;
    logger.info("supabase_metrics.scrape.completed", {
      scrapeId,
      scraped: parsed.samples.length,
      matched: shapedRows.length,
      written,
      skippedLines: parsed.skippedLines,
      durationMs,
    });

    return NextResponse.json({
      ok: true,
      scrapeId,
      scraped: parsed.samples.length,
      matched: shapedRows.length,
      written,
      durationMs,
      asOf: asOf.toISOString(),
    });
  } catch (err) {
    // Outer safety net — should never reach this in practice. Every
    // expected failure path returns above.
    logger.error("supabase_metrics.scrape.unhandled_error", {
      scrapeId,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { ok: false, error: "unhandled" },
      { status: 200 },
    );
  }
}
