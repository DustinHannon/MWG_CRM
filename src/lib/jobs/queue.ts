import "server-only";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobQueue, jobQueueDeadLetter } from "@/db/schema/jobs";
import { writeAudit } from "@/lib/audit";
import { SYSTEM_SENTINEL_USER_ID } from "@/lib/constants/system-users";
import { logger } from "@/lib/logger";
import { NonRetryableJobError } from "./errors";
import {
  type EnqueueOptions,
  type JobKind,
  type JobPayloadFor,
  type JobRecord,
  MAX_ATTEMPTS_DEFAULT,
  STALE_CLAIM_MS,
  WORKER_BATCH_SIZE,
} from "./types";

/**
 * Runtime API for the durable async job queue (F-Ω-8).
 *
 * Public surface (STANDARDS §19.10):
 *   - enqueueJob       — caller-facing INSERT with optional dedup.
 *   - claimNextJobs    — worker-facing atomic claim (FOR UPDATE SKIP LOCKED).
 *   - markJobSucceeded — terminal-success transition (atomic conditional).
 *   - markJobFailed    — retryable failure with exponential-backoff requeue
 *                        OR terminal failure (delegates to moveToDeadLetter).
 *   - moveToDeadLetter — DLQ migration in a transaction; audit fires after.
 *   - sweepStaleClaims — resurface orphaned processing rows (worker died).
 *
 * Supavisor locking discipline (CLAUDE.md "Postgres locking under Supavisor"):
 *   - claimNextJobs uses `SELECT ... FOR UPDATE SKIP LOCKED` INSIDE an
 *     explicit `db.transaction(...)`. The lock is transaction-scoped, so
 *     it cannot orphan when Supavisor rotates backends.
 *   - Every other state transition uses atomic conditional UPDATE
 *     (§19.5.2) — `WHERE id = ? AND status = <expected>`.
 *   - No session-scoped advisory locks. No `LOCK TABLE`.
 *
 * Audit emission discipline (STANDARDS §19.1.2):
 *   - writeAudit is called AFTER any transaction commits. No audit emission
 *     inside the tx body.
 *   - Audits attribute to the row's `actorId` when present, else fall back
 *     to SYSTEM_SENTINEL_USER_ID (§19.7.3).
 */

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Truncate error messages persisted to the row. Bounds row size. */
const LAST_ERROR_MAX_LEN = 2000;

function truncateError(err: Error | string | null): string | null {
  if (err === null) return null;
  const raw = typeof err === "string" ? err : (err.message ?? String(err));
  if (raw.length <= LAST_ERROR_MAX_LEN) return raw;
  return `${raw.slice(0, LAST_ERROR_MAX_LEN - 3)}...`;
}

/**
 * Compute the next-attempt-at delay (ms) using exponential backoff with
 * full jitter.
 *
 * Formula (AWS "Exponential Backoff and Jitter" — full-jitter variant):
 *   uncapped = BASE_MS * 2^(attemptCount - 1)
 *   capped   = min(uncapped, MAX_BACKOFF_MS)
 *   delay    = random(0, capped)
 *
 * Why full jitter:
 *   - Equal jitter (delay = capped/2 + random(0, capped/2)) still produces
 *     synchronized retry waves when many workers fail simultaneously on a
 *     shared downstream (e.g., a brief blob-store outage).
 *   - Full jitter de-synchronizes worker clusters without sacrificing the
 *     exponential-mean property — the EXPECTED wait still doubles per
 *     attempt; only the per-job realization is randomized.
 *
 * Why these constants:
 *   - BASE_MS=1000: smallest meaningful backoff that doesn't tight-loop;
 *     matches the §19.10.3 SendGrid retry shape (2s/4s/8s) but starts a
 *     beat earlier since the queue's own cron tick is the latency floor.
 *   - MAX_BACKOFF_MS=30000: 30s ceiling. Beyond this, retries cease to be
 *     "retries" — they're scheduled work, and the cron tick (1m) becomes
 *     the binding constraint. Capping at 30s lets the next cron tick
 *     pick up the job rather than wedging it longer than necessary.
 *
 * @param attemptCount Next attempt number, 1-indexed. The job that just
 * failed was attemptCount-1; the row is about to enter `pending` for the
 * attemptCount-th try. Passing 0 returns 0 ms (caller MUST guard).
 */
export function computeBackoffMs(
  attemptCount: number,
  opts?: { baseMs?: number; maxMs?: number; rng?: () => number },
): number {
  const baseMs = opts?.baseMs ?? 1000;
  const maxMs = opts?.maxMs ?? 30_000;
  const rng = opts?.rng ?? Math.random;
  if (attemptCount <= 0) return 0;
  // attempt 1 → 1s ceiling, attempt 2 → 2s, attempt 3 → 4s, attempt 4 → 8s,
  // attempt 5 → 16s, attempt 6+ → 30s (capped).
  const exp = Math.min(baseMs * 2 ** (attemptCount - 1), maxMs);
  // Math.random is [0, 1), so the realized delay is [0, exp). Including 0 is
  // fine — that's the worker re-claiming on the next tick.
  return Math.floor(rng() * exp);
}

/**
 * Map a Drizzle row to the public JobRecord shape. Drizzle returns the
 * inferred-select shape, which already matches but isn't typed against
 * the public JobKind/JobPayloadFor union — we widen-then-narrow here
 * once so callers downstream get the typed view.
 */
function toJobRecord<K extends JobKind = JobKind>(row: {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  enqueuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  idempotencyKey: string | null;
  metadata: unknown;
  actorId: string | null;
}): JobRecord<K> {
  return {
    id: row.id,
    kind: row.kind as K,
    payload: row.payload as JobPayloadFor<K>,
    status: row.status as JobRecord["status"],
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    claimedAt: row.claimedAt,
    claimedBy: row.claimedBy,
    enqueuedAt: row.enqueuedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastError: row.lastError,
    idempotencyKey: row.idempotencyKey,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    actorId: row.actorId,
  };
}

/* -------------------------------------------------------------------------- */
/* enqueueJob                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue a job. Returns the persisted JobRecord.
 *
 * Idempotency: when `options.idempotencyKey` is supplied and a row with
 * the same key already exists (ANY status — including dead-letter sourced
 * rows that have since been deleted from job_queue), we return the
 * existing row without creating a duplicate.
 *
 * Implementation note: a naive INSERT-then-catch-FK-violation pattern is
 * vulnerable to losing the existing-row return path; we use Postgres's
 * native `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
 * DO NOTHING RETURNING *` and fall back to a SELECT on the unique key
 * when RETURNING is empty (the conflict path). One round trip in the
 * happy path; two in the dedup-hit path.
 */
export async function enqueueJob<K extends JobKind>(
  kind: K,
  payload: JobPayloadFor<K>,
  options?: EnqueueOptions,
): Promise<JobRecord<K>> {
  const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    // Defensive validation — caller bug, not a user-input bug. A
    // negative or zero retry budget is a non-sensical job; refuse it.
    // (Throws plain Error: this is an invariant violation, not a typed
    // app-domain error.)
    throw new Error(
      `enqueueJob: maxAttempts must be a positive integer (got ${maxAttempts})`,
    );
  }

  const idempotencyKey = options?.idempotencyKey ?? null;
  const runAfter = options?.runAfter ?? null;
  const metadata = options?.metadata ?? null;
  const actorId = options?.actorId ?? null;

  // INSERT path. ON CONFLICT DO NOTHING returns 0 rows when the unique
  // index already has the key. Drizzle's `onConflictDoNothing()` builds
  // exactly that.
  const inserted = await db
    .insert(jobQueue)
    .values({
      kind,
      payload: payload as unknown as object,
      // status, attemptCount, maxAttempts default in schema, but we
      // override maxAttempts when supplied.
      maxAttempts,
      ...(runAfter ? { nextAttemptAt: runAfter } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(metadata ? { metadata } : {}),
      ...(actorId ? { actorId } : {}),
    })
    .onConflictDoNothing({ target: jobQueue.idempotencyKey })
    .returning();

  if (inserted.length === 1) {
    return toJobRecord<K>(inserted[0]!);
  }

  // Conflict path: existing row matched the idempotency key. Caller
  // expects the existing row back (no-op dedup). This branch is only
  // reachable when idempotencyKey was supplied — without it, the unique
  // index doesn't trigger and the INSERT always returns the new row.
  if (!idempotencyKey) {
    // Defensive: INSERT without conflict target returned empty. This
    // shouldn't be reachable; surface loudly so we don't silently lose
    // the work.
    logger.error("jobs.enqueue.no_rows_returned", { kind });
    throw new Error("enqueueJob: INSERT returned no rows (no conflict target)");
  }

  const [existing] = await db
    .select()
    .from(jobQueue)
    .where(eq(jobQueue.idempotencyKey, idempotencyKey))
    .limit(1);

  if (!existing) {
    // Pathological: idempotency key collided on INSERT but no row
    // exists on follow-up SELECT. Possible explanations:
    //   1. The colliding row was claimed + completed + a future cleanup
    //      job (not yet built) deleted it between INSERT and SELECT.
    //   2. A transient pooled-connection-visibility quirk.
    // In either case the user-visible outcome should be "the job is
    // queued"; retry the INSERT once — at this point either it succeeds
    // (no longer colliding) or the conflict is real and we re-enter
    // this branch with a SELECT that does find the row.
    logger.warn("jobs.enqueue.conflict_but_no_row", { kind, idempotencyKey });
    const retried = await db
      .insert(jobQueue)
      .values({
        kind,
        payload: payload as unknown as object,
        maxAttempts,
        ...(runAfter ? { nextAttemptAt: runAfter } : {}),
        idempotencyKey,
        ...(metadata ? { metadata } : {}),
        ...(actorId ? { actorId } : {}),
      })
      .onConflictDoNothing({ target: jobQueue.idempotencyKey })
      .returning();
    if (retried.length === 1) return toJobRecord<K>(retried[0]!);
    // Second attempt also collided — give up and re-SELECT. If still
    // missing, throw; caller can decide what to do.
    const [secondLook] = await db
      .select()
      .from(jobQueue)
      .where(eq(jobQueue.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!secondLook) {
      throw new Error(
        `enqueueJob: idempotency key '${idempotencyKey}' collided but no row visible`,
      );
    }
    return toJobRecord<K>(secondLook);
  }
  return toJobRecord<K>(existing);
}

/* -------------------------------------------------------------------------- */
/* claimNextJobs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Atomically claim up to `limit` pending jobs whose `kind` is in `kinds`
 * and whose `next_attempt_at <= now()`.
 *
 * Two-stage shape inside `db.transaction(...)`:
 *   1. SELECT ... FOR UPDATE SKIP LOCKED — pick eligible rows. SKIP LOCKED
 *      means other concurrent workers' claims are invisible to ours and we
 *      don't block waiting for them. Each worker gets a disjoint subset.
 *   2. UPDATE ... WHERE id = ANY($1) — transition to processing, stamp
 *      claimed_at / claimed_by / started_at, increment attempt_count.
 *      Returns the updated rows.
 *
 * Why two stages instead of `UPDATE ... WHERE ... RETURNING` with a CTE:
 *   - `SELECT FOR UPDATE SKIP LOCKED` is the only construct that guarantees
 *     non-blocking, non-contending row selection across concurrent workers.
 *     A bare UPDATE with `WHERE status = 'pending'` would either block on
 *     other workers' locked rows (default behavior) or NOT skip them
 *     (because the UPDATE row-lock acquisition doesn't have a SKIP LOCKED
 *     form in Postgres).
 *   - The combined CTE form is supported in Postgres but Drizzle's typed
 *     query builder doesn't model it cleanly; raw `sql\`...\`` lets us
 *     express it directly.
 *
 * Transactionality: both stages run inside `db.transaction`. The row locks
 * acquired by FOR UPDATE are released on commit; if the UPDATE fails the
 * tx rolls back and no row is claimed (the locks evaporate cleanly).
 *
 * Per STANDARDS §19.10.1 the claim is the dispatch trigger — once a row
 * is claimed by this worker, no other worker can take it until either
 * markJobSucceeded, markJobFailed (with retry surfacing it), the stale-
 * claim sweep resurfaces it, or moveToDeadLetter terminates it.
 *
 * Limit clamping: enforced server-side via the SELECT LIMIT. Default is
 * `WORKER_BATCH_SIZE` (25 — see types.ts). Caller cannot exceed
 * `WORKER_BATCH_SIZE * 4` (defensive ceiling — the worker invocation
 * budget can't handle more than that anyway).
 */
export async function claimNextJobs(
  kinds: JobKind[],
  workerId: string,
  limit: number = WORKER_BATCH_SIZE,
): Promise<JobRecord[]> {
  if (kinds.length === 0) return [];
  if (!workerId || workerId.length === 0) {
    throw new Error("claimNextJobs: workerId is required");
  }
  // Defensive clamp. The schema's `kind` column is text, so any union of
  // string literals fits naturally — but we still validate non-empty.
  const clampedLimit = Math.max(1, Math.min(limit, WORKER_BATCH_SIZE * 4));

  return await db.transaction(async (tx) => {
    // Stage 1: SELECT FOR UPDATE SKIP LOCKED.
    // The `claim_idx` partial index on (kind, next_attempt_at) WHERE
    // status='pending' covers this scan exactly.
    const eligible = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM job_queue
      WHERE status = 'pending'
        AND kind = ANY(${kinds})
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC, enqueued_at ASC
      LIMIT ${clampedLimit}
      FOR UPDATE SKIP LOCKED
    `);

    // Drizzle's `tx.execute` returns a postgres-js result; normalize.
    const eligibleRows = reconcileExecResultRows(eligible) as Array<{
      id: string;
    }>;
    if (eligibleRows.length === 0) return [];
    const ids = eligibleRows.map((r) => r.id);

    // Stage 2: transition selected rows. Returning() gives the full row
    // shape so the worker has the payload + attempt context without
    // a second round trip.
    const claimed = await tx
      .update(jobQueue)
      .set({
        status: "processing",
        claimedAt: sql`now()`,
        claimedBy: workerId,
        startedAt: sql`now()`,
        attemptCount: sql`${jobQueue.attemptCount} + 1`,
      })
      .where(inArray(jobQueue.id, ids))
      .returning();

    return claimed.map(toJobRecord);
  });
}

/* -------------------------------------------------------------------------- */
/* markJobSucceeded                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Atomic conditional UPDATE: set status='succeeded', completed_at=now()
 * WHERE id=? AND status='processing'.
 *
 * No-op on mismatch (stale-claim race, already marked, etc.). The
 * worker's mark-success is best-effort — once a row is succeeded, the
 * post-mortem path doesn't need to retry the marker, and re-mark from a
 * stale claim would clobber a legitimate retry. We log warn and return.
 *
 * Audit: emitted after the conditional UPDATE returns at least one row.
 * Audit emission failure does NOT block (per §19.1.2 / §19.7.1).
 */
export async function markJobSucceeded(jobId: string): Promise<void> {
  const updated = await db
    .update(jobQueue)
    .set({
      status: "succeeded",
      completedAt: sql`now()`,
      // Clear the last-error field — we don't want a stale error string
      // hanging on a row that ultimately succeeded.
      lastError: null,
    })
    .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, "processing")))
    .returning({
      id: jobQueue.id,
      kind: jobQueue.kind,
      actorId: jobQueue.actorId,
      attemptCount: jobQueue.attemptCount,
    });

  if (updated.length === 0) {
    logger.warn("jobs.mark_succeeded.no_match", {
      jobId,
      reason: "row not in processing state (stale claim or already marked)",
    });
    return;
  }

  const row = updated[0]!;
  await writeAudit({
    actorId: row.actorId ?? SYSTEM_SENTINEL_USER_ID,
    action: "job.succeeded",
    targetType: "job_queue",
    targetId: row.id,
    after: { kind: row.kind, attemptCount: row.attemptCount },
  });
}

/* -------------------------------------------------------------------------- */
/* markJobFailed                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Record a failed attempt.
 *
 * Branches:
 *   - retryable === false: terminal. Move to dead-letter immediately.
 *     Failure reason = 'non-retryable-error'.
 *   - retryable === true AND attempt_count >= max_attempts: budget
 *     exhausted. Move to dead-letter. Failure reason =
 *     'max-attempts-exceeded'.
 *   - retryable === true AND attempt_count < max_attempts: requeue with
 *     exponential backoff. Atomic conditional UPDATE flips status back
 *     to 'pending'; another worker may claim on the next tick after the
 *     backoff window expires.
 *
 * Inputs assume the row is currently in 'processing' state (the worker
 * just finished its attempt). If the row has been resurfaced by the
 * stale-claim sweeper between attempt start and this call, the atomic
 * UPDATE will not match — we log warn and the row continues in its
 * resurfaced state (the next claim will run a fresh attempt).
 *
 * NonRetryableJobError special-case: callers MAY pass a
 * `NonRetryableJobError` as the error AND retryable=true — we honor the
 * error class over the boolean (defense in depth). The worker shell
 * should match these semantically, but the queue is the final authority.
 */
export async function markJobFailed(
  jobId: string,
  error: Error,
  retryable: boolean,
): Promise<{ deadLettered: boolean }> {
  // NonRetryableJobError forces the terminal branch regardless of the
  // caller's boolean. This makes the call sites less error-prone — a
  // handler that throws NonRetryableJobError doesn't depend on the
  // worker shell forwarding the right boolean.
  const effectiveRetryable = retryable && !(error instanceof NonRetryableJobError);

  // Read the row's attempt context. We need attempt_count + max_attempts
  // to decide between requeue and dead-letter, and the read MUST happen
  // before the atomic UPDATE so we know which branch to take.
  //
  // Race note: this SELECT could observe a different attempt_count than
  // the row currently has if the stale-claim sweeper ran between attempt
  // start and now. That's fine — the subsequent atomic UPDATE encodes
  // the expected status='processing' AND id=? predicate, so a sweep that
  // already resurfaced the row will cause our UPDATE to no-op, and the
  // next attempt will run cleanly.
  const [row] = await db
    .select({
      id: jobQueue.id,
      kind: jobQueue.kind,
      attemptCount: jobQueue.attemptCount,
      maxAttempts: jobQueue.maxAttempts,
      actorId: jobQueue.actorId,
      payload: jobQueue.payload,
      metadata: jobQueue.metadata,
      enqueuedAt: jobQueue.enqueuedAt,
    })
    .from(jobQueue)
    .where(eq(jobQueue.id, jobId))
    .limit(1);

  if (!row) {
    // Row no longer exists. Possible explanations:
    //   1. moveToDeadLetter already ran from another path.
    //   2. A future cleanup job deleted it.
    // Either way the markFailed is a no-op; log and return.
    logger.warn("jobs.mark_failed.row_missing", { jobId });
    return { deadLettered: false };
  }

  const errorMessage = truncateError(error);
  const exhausted = row.attemptCount >= row.maxAttempts;

  if (!effectiveRetryable || exhausted) {
    await moveToDeadLetter(
      jobId,
      !effectiveRetryable ? "non-retryable-error" : "max-attempts-exceeded",
      errorMessage,
    );
    return { deadLettered: true };
  }

  // Retryable + budget remaining: requeue.
  const backoffMs = computeBackoffMs(row.attemptCount + 1);
  const updated = await db
    .update(jobQueue)
    .set({
      status: "pending",
      lastError: errorMessage,
      // Schedule next attempt via raw interval — keeps the math
      // server-side so the worker clock doesn't have to agree with
      // Postgres's clock. The cast is because Drizzle's typed UPDATE
      // expects a Date for timestamp columns.
      nextAttemptAt: sql`now() + (${backoffMs} || ' milliseconds')::interval`,
      // Clear claim metadata so the next claim cycle resets cleanly.
      claimedAt: null,
      claimedBy: null,
    })
    .where(and(eq(jobQueue.id, jobId), eq(jobQueue.status, "processing")))
    .returning({ id: jobQueue.id });

  if (updated.length === 0) {
    logger.warn("jobs.mark_failed.no_match", {
      jobId,
      reason: "row not in processing state (concurrent sweep or already terminal)",
    });
    return { deadLettered: false };
  }

  await writeAudit({
    actorId: row.actorId ?? SYSTEM_SENTINEL_USER_ID,
    action: "job.retry_scheduled",
    targetType: "job_queue",
    targetId: jobId,
    after: {
      kind: row.kind,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      backoffMs,
      errorMessage,
    },
  });
  return { deadLettered: false };
}

/* -------------------------------------------------------------------------- */
/* moveToDeadLetter                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Move a job from `job_queue` to `job_queue_dead_letter`, atomically.
 *
 * Transactional shape:
 *   BEGIN
 *     INSERT INTO job_queue_dead_letter (snapshot of source row) RETURNING *
 *     DELETE FROM job_queue WHERE id = ?
 *   COMMIT
 *   -- audit emitted AFTER commit (§19.1.2)
 *
 * Why a transaction:
 *   - The source row contains the payload + metadata we need to snapshot
 *     into the DLQ row. If the DLETE fired first, the DLQ INSERT would
 *     have to recompute or risk pulling from a deleted view.
 *   - If only one side ran (DLQ INSERT succeeded but job_queue DELETE
 *     failed, or vice versa), the row would either appear in both tables
 *     (duplicate forensic record) or vanish from both (lost work).
 *
 * Race resilience: if another path concurrently calls moveToDeadLetter
 * for the same id, the second caller's job_queue DELETE will affect 0
 * rows AND the DLQ INSERT will succeed (no unique constraint on
 * original_job_id intentionally — see schema). We tolerate the
 * second-DLQ-insert because:
 *   - Adding a UNIQUE(original_job_id) constraint would convert a benign
 *     race into a hard error.
 *   - The audit row makes it observable.
 *   - The dead-letter table is forensic, not transactional.
 *
 * If exactly-once DLQ membership becomes required, add the unique
 * constraint AND wrap the INSERT in `ON CONFLICT (original_job_id) DO
 * NOTHING` — but no current consumer needs that.
 */
export async function moveToDeadLetter(
  jobId: string,
  failureReason: string,
  lastError: string | null,
): Promise<void> {
  // Read once outside the tx for audit attribution. The values we
  // capture here are also what we snapshot into the DLQ row.
  const [source] = await db
    .select()
    .from(jobQueue)
    .where(eq(jobQueue.id, jobId))
    .limit(1);

  if (!source) {
    // Already moved (or never existed). Log warn — calling
    // moveToDeadLetter on a missing row usually means a double-call
    // race, which is benign but worth observing.
    logger.warn("jobs.move_to_dead_letter.row_missing", { jobId, failureReason });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.insert(jobQueueDeadLetter).values({
      originalJobId: source.id,
      kind: source.kind,
      payload: source.payload as unknown as object,
      attemptCount: source.attemptCount,
      failureReason,
      lastError,
      enqueuedAt: source.enqueuedAt,
      originalMetadata:
        source.metadata === null ? null : (source.metadata as unknown as object),
      actorId: source.actorId,
    });

    // Conditional DELETE — if another path already moved this row
    // between our SELECT and now, this is a no-op and we tolerate the
    // duplicate DLQ insert (see top-of-function note).
    await tx.delete(jobQueue).where(eq(jobQueue.id, jobId));
  });

  // Audit AFTER tx commits — §19.1.2. Even if the audit fails, the data
  // move has already committed; writeAudit is best-effort internally.
  await writeAudit({
    actorId: source.actorId ?? SYSTEM_SENTINEL_USER_ID,
    action: "job.dead_letter",
    targetType: "job_queue",
    targetId: source.id,
    after: {
      kind: source.kind,
      failureReason,
      attemptCount: source.attemptCount,
      maxAttempts: source.maxAttempts,
      lastError,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* sweepStaleClaims                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Find rows stuck in `processing` whose `claimed_at` is older than
 * STALE_CLAIM_MS, and resurface them by:
 *   - status='pending'
 *   - next_attempt_at=now() (eligible for immediate re-claim)
 *   - claimed_at=NULL, claimed_by=NULL
 *
 * The atomic UPDATE encodes BOTH `status='processing'` AND the staleness
 * predicate. Concurrent workers calling markJobSucceeded / markJobFailed
 * on these rows will collide with this UPDATE; the loser of the race
 * gets a 0-row return, which they already handle (log warn, no-op).
 *
 * Idempotent: re-running with no stale rows returns `{ resurfaced: 0 }`.
 * Designed to run from the worker each cron tick before claiming new
 * jobs, so the same worker that crashed mid-handler last tick can
 * recover its own orphaned work on the next tick.
 *
 * Does NOT increment attempt_count — the failed attempt that orphaned
 * the row already consumed its slot (attempt_count was incremented at
 * claim time). The next claim cycle will run attempt N+1, where N was
 * the attempt that died mid-flight.
 *
 * Audit: aggregated emission. Resurfacing N rows emits ONE audit row
 * with `{ count: N, sampleIds, firstAt, lastAt }` per CLAUDE.md
 * "Audit emission for high-frequency events". Stale-claim sweeps are a
 * workflow event, not a governance event — count and timing matter more
 * than per-row forensic detail (the dead-letter table and the row's
 * lastError already carry the forensic detail).
 */
export async function sweepStaleClaims(): Promise<{ resurfaced: number }> {
  const cutoffMs = STALE_CLAIM_MS;
  const updated = await db
    .update(jobQueue)
    .set({
      status: "pending",
      nextAttemptAt: sql`now()`,
      claimedAt: null,
      claimedBy: null,
    })
    .where(
      and(
        eq(jobQueue.status, "processing"),
        // claimedAt < now() - INTERVAL '<cutoff> milliseconds'
        // We compare against `claimedAt` directly; rows with NULL
        // claimedAt cannot be in 'processing' (claim stamps it), but
        // the predicate is null-safe via lt().
        lt(
          jobQueue.claimedAt,
          sql`now() - (${cutoffMs} || ' milliseconds')::interval`,
        ),
      ),
    )
    .returning({
      id: jobQueue.id,
      kind: jobQueue.kind,
      claimedBy: jobQueue.claimedBy,
    });

  if (updated.length === 0) return { resurfaced: 0 };

  logger.warn("jobs.stale_claim.resurfaced", {
    count: updated.length,
    sampleIds: updated.slice(0, 5).map((r) => r.id),
  });

  // Aggregated audit row. Attribute to the sentinel user since the
  // sweeper has no human actor.
  await writeAudit({
    actorId: SYSTEM_SENTINEL_USER_ID,
    action: "job.stale_claim_resurfaced",
    targetType: "job_queue",
    // No single targetId — bulk event.
    after: {
      count: updated.length,
      sampleIds: updated.slice(0, 10).map((r) => r.id),
      sampleKinds: Array.from(new Set(updated.map((r) => r.kind))).slice(0, 10),
      cutoffMs,
    },
  });

  return { resurfaced: updated.length };
}

/* -------------------------------------------------------------------------- */
/* internal: postgres-js result normalizer                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drizzle's `tx.execute(sql\`…\`)` returns a postgres-js shape. In our
 * config the result is iterable AND has a numeric length — so it
 * behaves array-like. We accept both possibilities (some Drizzle
 * versions return `{ rows: [...] }`-shaped objects under different
 * drivers; the marketing webhook normalizes the same way).
 */
function reconcileExecResultRows(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null && "rows" in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r;
  }
  return [];
}
