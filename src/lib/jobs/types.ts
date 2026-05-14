/**
 * Public type contracts for the durable async job queue (F-Ω-8).
 *
 * Anyone enqueuing work — fire-and-forget refactors, scheduled-job
 * orchestration, the worker cron — imports from here. Schema tables live in
 * `src/db/schema/jobs.ts`; runtime API in `src/lib/jobs/queue.ts`.
 *
 * Contract surface:
 *   - JobKind: handler discriminator. New handlers extend the union.
 *   - JobStatus: lifecycle states. Mirrors `job_queue.status` column.
 *   - JobPayloadFor<K>: per-kind payload shape. Handlers narrow at execution.
 *   - EnqueueOptions: caller-tunable knobs (idempotency, scheduling, retry budget).
 *   - JobRecord / DeadLetterRecord: the row-shaped views returned by queue ops.
 *   - JobHandler: function shape every handler implements + the handler-side
 *     idempotency contract.
 *
 * Adding a new handler:
 *   1. Add the kind to JobKind.
 *   2. Add the payload type to JobPayloadByKind.
 *   3. Implement and register a JobHandler in `src/lib/jobs/handlers/`.
 *   4. Document the idempotency strategy inline in the handler.
 */

/**
 * Handler discriminator. Every job in the queue belongs to exactly one kind.
 * Extend this union when adding a handler — the registry in
 * `src/lib/jobs/handlers/index.ts` is built off this same set so the compiler
 * catches missing handler registrations.
 */
export type JobKind = "blob-cleanup";

/**
 * Per-kind payload shapes. Add the shape for each new JobKind; the
 * compiler enforces exhaustive handler coverage.
 */
export type JobPayloadByKind = {
  /**
   * Delete a set of Vercel Blob objects by pathname.
   *
   * The pathnames must already have been pre-gathered before the parent
   * DB delete cascade ran (STANDARDS §19.4.1). The handler issues
   * `del(pathname)` for each and tolerates 404s as "already cleaned."
   * Idempotency: re-running the job after partial success is safe; the
   * second pass no-ops already-deleted blobs.
   */
  "blob-cleanup": {
    pathnames: string[];
    /** Optional context (origin table + id) for debugging stuck dead-letters. */
    origin?: {
      entityType: "lead" | "account" | "contact" | "opportunity" | "task";
      entityId: string;
    };
  };
};

export type JobPayloadFor<K extends JobKind> = JobPayloadByKind[K];

/**
 * Lifecycle state. Mirrors the `job_queue.status` column.
 *
 *   pending     — awaiting claim. `nextAttemptAt <= now()` means ready.
 *   processing  — claimed by a worker. Stale claims (>5 min) are swept.
 *   succeeded   — handler completed cleanly.
 *   failed      — retryable failure between attempts. Returns to pending
 *                 after `nextAttemptAt`. Terminal failures move to the
 *                 dead-letter table and the original row is deleted.
 */
export type JobStatus = "pending" | "processing" | "succeeded" | "failed";

export interface EnqueueOptions {
  /**
   * Caller-supplied dedup key. If a job with the same key already exists
   * (any status), the enqueue is a no-op and returns the existing row.
   * Use when the producer is not naturally idempotent.
   */
  idempotencyKey?: string;
  /**
   * Earliest time the job is eligible to run. Defaults to `now()`.
   * Use for scheduled work (e.g., delayed cleanup).
   */
  runAfter?: Date;
  /**
   * Per-job retry budget override. Defaults to MAX_ATTEMPTS_DEFAULT (5).
   * Lower for non-critical work that should give up quickly; raise for
   * work where eventual success is more important than promptness.
   */
  maxAttempts?: number;
  /**
   * Free-form debugging context. Stored on the row; copied to dead-letter
   * on terminal failure. Typical: `{ requestId, userIp }`.
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional user FK. Set null on user delete (queue rows outlive users).
   */
  actorId?: string;
}

export interface JobRecord<K extends JobKind = JobKind> {
  id: string;
  kind: K;
  payload: JobPayloadFor<K>;
  status: JobStatus;
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
  metadata: Record<string, unknown> | null;
  actorId: string | null;
}

export interface DeadLetterRecord<K extends JobKind = JobKind> {
  id: string;
  originalJobId: string;
  kind: K;
  payload: JobPayloadFor<K>;
  attemptCount: number;
  failureReason: string;
  lastError: string | null;
  enqueuedAt: Date;
  failedAt: Date;
  originalMetadata: Record<string, unknown> | null;
  actorId: string | null;
}

/**
 * Handler contract. Every kind has exactly one handler.
 *
 * Idempotency: handlers MUST be safe to invoke twice on the same payload.
 * The worker may dispatch the same row a second time if (a) the worker
 * crashes after handler success but before markJobSucceeded, or (b) the
 * stale-claim sweep reclaims a row whose worker invocation died mid-execution.
 *
 * Throw a `NonRetryableJobError` (see `src/lib/jobs/errors.ts`) when the
 * payload is structurally invalid or the failure is permanent — the queue
 * moves to dead-letter immediately without consuming the retry budget.
 * Throw any other error to consume one retry attempt; the queue applies
 * exponential backoff and resurfaces the job for the next attempt.
 */
export type JobHandler<K extends JobKind> = (
  payload: JobPayloadFor<K>,
  context: JobHandlerContext,
) => Promise<void>;

export interface JobHandlerContext {
  /** The row ID — for logging and audit emission. */
  jobId: string;
  /** Current attempt count (1-indexed). Useful for "log only on first try" decisions. */
  attempt: number;
  /** Max attempts the row will be allowed. */
  maxAttempts: number;
}

/**
 * Default retry budget. Callers can override per-job via EnqueueOptions.maxAttempts.
 */
export const MAX_ATTEMPTS_DEFAULT = 5;

/**
 * Stale-claim threshold. A `processing` row whose `claimedAt` is older than
 * this is assumed orphaned (worker died) and resurfaced for re-claim.
 */
export const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Per-worker-invocation batch size. The worker claims up to this many jobs
 * per cron tick and processes them sequentially within the invocation budget.
 */
export const WORKER_BATCH_SIZE = 25;

/**
 * Maximum runtime per worker invocation. Hard cap so the worker yields back
 * to the platform with time to spare for shutdown / flush.
 */
export const WORKER_MAX_RUNTIME_MS = 4 * 60 * 1000;
