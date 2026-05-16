import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeSystemAudit } from "@/lib/audit";
import { requireCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { dispatchJob, handlers } from "@/lib/jobs/handlers";
import { NonRetryableJobError } from "@/lib/jobs/errors";
import {
  claimNextJobs,
  markJobSucceeded,
  markJobFailed,
  sweepStaleClaims,
} from "@/lib/jobs/queue";
import {
  WORKER_BATCH_SIZE,
  WORKER_MAX_RUNTIME_MS,
  type JobKind,
  type JobRecord,
} from "@/lib/jobs/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Durable async job-queue worker (F-Ω-8).
 *
 * Vercel Cron entry point. Each invocation:
 *
 *   1. Authenticates the request against `CRON_SECRET` (timing-safe).
 *   2. Sweeps stale `processing` rows (claim older than `STALE_CLAIM_MS`)
 *      back to `pending` so they're eligible for re-claim. Sweep runs
 *      FIRST so a worker that died mid-batch on the previous tick has
 *      its rows recovered immediately.
 *   3. Claims up to `WORKER_BATCH_SIZE` ready jobs in one transaction
 *      (queue library uses `SELECT ... FOR UPDATE SKIP LOCKED` — see
 *      STANDARDS §19 Supavisor-safe locking notes).
 *   4. Dispatches each claimed job to its registered handler via
 *      `dispatchJob(kind, payload, context)`. Outcomes:
 *        - resolves   → `markJobSucceeded`.
 *        - `NonRetryableJobError` → `markJobFailed(retryable: false)` →
 *          row moves to `job_queue_dead_letter` immediately.
 *        - any other throw → `markJobFailed(retryable: true)` →
 *          row returns to `pending` with exponential backoff if attempts
 *          remain, or moves to dead-letter on exhaustion (queue lib
 *          enforces the budget; this route just reports the outcome).
 *   5. Stops claiming new work when the wall-clock budget drops below
 *      `RUNTIME_GUARD_MS`. In-flight handlers are NOT cancelled — they
 *      finish naturally and Vercel's hard 300s ceiling backstops them.
 *   6. Emits a single aggregated audit row per invocation (per STANDARDS
 *      §19 high-frequency audit aggregation rule).
 *   7. Returns a JSON summary so cron monitoring can inspect the run
 *      outcome directly.
 *
 * Schedule: every 5 minutes (see `vercel.json` crons). The cadence
 * balances fast-feedback against worker connection pressure;
 * enqueue-to-first-attempt latency stays within a few minutes.
 */

/**
 * Stop accepting new work when this many milliseconds remain in the
 * runtime budget. Gives in-flight handlers headroom to finish, the audit
 * write headroom to land, and the JSON response headroom to flush.
 *
 * Sized at 30s: a slow handler doing a network round-trip in the last
 * batch slot should still finish; the audit + response are quick.
 */
const RUNTIME_GUARD_MS = 30_000;

/**
 * Maximum bytes of error message to persist on `last_error` /
 * `failure_reason`. Postgres `text` is unbounded but logs / dead-letter
 * surfaces in the admin UI are easier to read with a sane cap, and
 * runaway error messages from unexpected handler bugs (e.g., circular
 * JSON serialization gone wrong) shouldn't bloat the row.
 */
const MAX_ERROR_MESSAGE_CHARS = 2_000;

interface RunSummary {
  workerId: string;
  staleClaimsSwept: number;
  claimed: number;
  succeeded: number;
  failedRetryable: number;
  deadLettered: number;
  durationMs: number;
  /**
   * True when the runtime guard stopped us from claiming a follow-up
   * batch. Cron monitoring can correlate this with backlog growth.
   */
  budgetExhausted: boolean;
}

export async function GET(req: Request): Promise<Response> {
  const unauth = requireCronAuth(req);
  if (unauth) return unauth;

  const workerId = randomUUID();
  const startedAt = Date.now();

  const summary: RunSummary = {
    workerId,
    staleClaimsSwept: 0,
    claimed: 0,
    succeeded: 0,
    failedRetryable: 0,
    deadLettered: 0,
    durationMs: 0,
    budgetExhausted: false,
  };

  try {
    // 1. Stale-claim sweep — surface orphaned `processing` rows first
    //    so the claim step below picks them up in the same tick. Failure
    //    here is logged and tolerated: a missed sweep just delays
    //    recovery by one cron cadence (60s), it doesn't lose work.
    try {
      const swept = await sweepStaleClaims();
      summary.staleClaimsSwept = typeof swept === "number" ? swept : 0;
    } catch (err) {
      logger.error("jobs.worker.sweep_failed", {
        workerId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Claim + dispatch loop. We claim up to WORKER_BATCH_SIZE jobs
    //    per pass, drain them, and re-claim if budget allows. This
    //    lets bursts drain inside one invocation when handlers are
    //    fast (e.g., blob deletes are mostly network-bound at <100ms).
    // All kinds with a registered handler — derived from the registry so
    // adding a JobKind + handler is the only change needed; the worker
    // picks it up automatically.
    const registeredKinds = Object.keys(handlers) as JobKind[];

    while (!budgetExhausted(startedAt)) {
      const jobs = await claimNextJobs(
        registeredKinds,
        workerId,
        WORKER_BATCH_SIZE,
      );
      if (jobs.length === 0) break;
      summary.claimed += jobs.length;

      for (const job of jobs) {
        // Per-job inner guard: a single slow handler that pushes us
        // past the budget shouldn't prevent in-flight rows from
        // reporting their outcome. We run the handler regardless of
        // budget (it's already claimed; abandoning it means leaving
        // it in `processing` until the next sweep).
        await runOneJob(job, summary, workerId);
      }

      if (budgetExhausted(startedAt)) {
        summary.budgetExhausted = true;
        break;
      }
    }
  } catch (err) {
    // Outer catch — claim itself failed (DB outage, connection drop).
    // We've already drained whatever was reported in `summary`.
    logger.error("jobs.worker.fatal", {
      workerId,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
    summary.durationMs = Date.now() - startedAt;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    await emitRunAudit(summary, /* ok */ false, errorMessage, errorStack);
    return NextResponse.json(
      { ok: false, error: "Worker failed", workerId, errorMessage },
      { status: 500 },
    );
  }

  summary.durationMs = Date.now() - startedAt;

  logger.info("jobs.worker.completed", {
    workerId,
    staleClaimsSwept: summary.staleClaimsSwept,
    claimed: summary.claimed,
    succeeded: summary.succeeded,
    failedRetryable: summary.failedRetryable,
    deadLettered: summary.deadLettered,
    budgetExhausted: summary.budgetExhausted,
    durationMs: summary.durationMs,
  });

  await emitRunAudit(summary, /* ok */ true);

  return NextResponse.json({ ok: true, ...summary });
}

/**
 * Execute a single claimed job: dispatch to its handler, then mark the
 * outcome on the queue. All thrown errors are caught and routed to
 * `markJobFailed`; the worker loop continues regardless so one bad job
 * doesn't poison the batch.
 */
async function runOneJob(
  job: JobRecord<JobKind>,
  summary: RunSummary,
  workerId: string,
): Promise<void> {
  const jobStartedAt = Date.now();
  const context = {
    jobId: job.id,
    attempt: job.attemptCount,
    maxAttempts: job.maxAttempts,
  };

  try {
    await dispatchJob(job.kind, job.payload, context);
    await markJobSucceeded(job.id);
    summary.succeeded += 1;
    logger.info("jobs.worker.job_succeeded", {
      workerId,
      jobId: job.id,
      kind: job.kind,
      attempt: job.attemptCount,
      durationMs: Date.now() - jobStartedAt,
    });
  } catch (err) {
    const nonRetryable = err instanceof NonRetryableJobError;
    const errorMessage = truncate(
      err instanceof Error ? err.message : String(err),
      MAX_ERROR_MESSAGE_CHARS,
    );

    try {
      const errorObj = err instanceof Error ? err : new Error(errorMessage);
      const result = await markJobFailed(job.id, errorObj, !nonRetryable);
      const deadLettered = result.deadLettered;
      if (deadLettered) {
        summary.deadLettered += 1;
      } else {
        summary.failedRetryable += 1;
      }

      const logLevel = deadLettered ? "error" : "warn";
      logger[logLevel]("jobs.worker.job_failed", {
        workerId,
        jobId: job.id,
        kind: job.kind,
        attempt: job.attemptCount,
        maxAttempts: job.maxAttempts,
        nonRetryable,
        deadLettered,
        durationMs: Date.now() - jobStartedAt,
        errorMessage,
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    } catch (markErr) {
      // The mark-failed call itself failed. The row stays in
      // `processing`; the next tick's stale-claim sweep recovers it.
      // We can't make markJobFailed atomic with handler execution from
      // here, so this is the irreducible failure mode.
      logger.error("jobs.worker.mark_failed_failed", {
        workerId,
        jobId: job.id,
        kind: job.kind,
        originalErrorMessage: errorMessage,
        markErrorMessage:
          markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }
}

/**
 * True when wall-clock time remaining is below `RUNTIME_GUARD_MS`.
 *
 * Computed against `WORKER_MAX_RUNTIME_MS` (the queue's own ceiling,
 * 4 minutes) rather than Vercel's 300s `maxDuration` so we yield with
 * the same margin regardless of platform tuning.
 */
function budgetExhausted(startedAt: number): boolean {
  return Date.now() - startedAt > WORKER_MAX_RUNTIME_MS - RUNTIME_GUARD_MS;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Aggregated per-run audit row. Per STANDARDS §19, high-frequency
 * workflow events emit a single audit row capturing `{ count, ... }`
 * rather than one row per job. Forensic detail per job lives in the
 * `job_queue` / `job_queue_dead_letter` rows themselves.
 */
async function emitRunAudit(
  summary: RunSummary,
  ok: boolean,
  errorMessage?: string,
  errorStack?: string,
): Promise<void> {
  await writeSystemAudit({
    actorEmailSnapshot: "system@cron",
    action: ok ? "jobs.processed" : "jobs.processed.failed",
    targetType: "system",
    after: {
      worker_id: summary.workerId,
      stale_claims_swept: summary.staleClaimsSwept,
      claimed: summary.claimed,
      succeeded: summary.succeeded,
      failed_retryable: summary.failedRetryable,
      dead_lettered: summary.deadLettered,
      duration_ms: summary.durationMs,
      budget_exhausted: summary.budgetExhausted,
      ...(errorMessage ? { error_message: errorMessage } : {}),
      ...(errorStack ? { error_stack: errorStack.split("\n").slice(0, 8).join("\n") } : {}),
    },
  });
}
