import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Durable async job queue. F-Ω-8 implementation per STANDARDS §19.10.
 *
 * Replaces fire-and-forget `void someAsync().catch(...)` patterns that risked
 * losing work to lambda termination. Callers enqueue a row; the worker cron
 * claims, executes, and marks success/failure with retry + exponential backoff.
 * Terminal failures move to `job_queue_dead_letter` for manual investigation.
 *
 * Status lifecycle:
 *   pending     — enqueued, awaiting claim. `next_attempt_at <= now()` = ready.
 *   processing  — claimed by a worker. `claimed_at` set; `claimed_by`
 *                 identifies the worker invocation for stale-claim sweep.
 *   succeeded   — handler completed without throwing.
 *   failed      — handler threw retryable error AND attempts < max. Re-enters
 *                 `pending` after `next_attempt_at`. Terminal failures or
 *                 attempt exhaustion move to `job_queue_dead_letter`.
 *
 * Claim pattern uses `SELECT ... FOR UPDATE SKIP LOCKED` inside an explicit
 * transaction (Supavisor-safe per STANDARDS §19 / CLAUDE.md Postgres locking).
 * Session-scoped advisory locks are forbidden here.
 *
 * Idempotency: every handler MUST be safe to re-run on the same payload. The
 * worker may invoke the handler twice (claim succeeds, mark-success fails,
 * row resurfaces). Handler implementations document their idempotency strategy
 * inline. Optional `idempotency_key` (unique when present) lets callers dedup
 * enqueues from non-idempotent producers.
 */
export const jobQueue = pgTable(
  "job_queue",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Handler discriminator (e.g., 'blob-cleanup'). Registry lives in `src/lib/jobs/handlers/`. */
    kind: text("kind").notNull(),
    /** Handler-specific input. Validated by the handler at execution time. */
    payload: jsonb("payload").notNull(),
    /** pending | processing | succeeded | failed */
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Earliest time the row is eligible to be claimed. Set on enqueue + on retry-backoff. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** When a worker most-recently claimed the row. NULL until first claim. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Worker invocation identifier (cron run id or similar). NULL until first claim. */
    claimedBy: text("claimed_by"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Start of the most recent attempt. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Set on terminal success. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Truncated error message from the most recent failed attempt. */
    lastError: text("last_error"),
    /** Optional caller-supplied dedup key. Unique when non-null. */
    idempotencyKey: text("idempotency_key"),
    /** Free-form debugging context (e.g., the originating request id). */
    metadata: jsonb("metadata"),
    /** Optional FK to the user who enqueued. Set null on user delete (queue rows outlive users). */
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (t) => [
    // Claim hot path: scan pending rows whose next_attempt_at <= now(), oldest first.
    index("job_queue_claim_idx")
      .on(t.kind, t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    // Stale-claim sweep: find processing rows that have been claimed too long.
    index("job_queue_stale_claim_idx")
      .on(t.claimedAt)
      .where(sql`status = 'processing'`),
    // Monitoring: status × kind for dashboards.
    index("job_queue_status_kind_idx").on(t.status, t.kind, t.enqueuedAt.desc()),
    // Optional dedup uniqueness when idempotency_key is supplied.
    uniqueIndex("job_queue_idempotency_key_idx")
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

/**
 * Terminal failures. A job lands here when:
 *   - attempt_count >= max_attempts, OR
 *   - the handler threw a non-retryable error (markJobFailed called with retryable=false).
 *
 * Manual investigation territory. The `marketing-process-scheduled-campaigns`
 * + `purge-archived` cron patterns are the precedent — failure surfacing
 * lives in `/admin` UIs (not built in this phase; F-Ω-8 admin surface deferred).
 */
export const jobQueueDeadLetter = pgTable(
  "job_queue_dead_letter",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Original `job_queue.id` for cross-reference. The original row is deleted on move. */
    originalJobId: uuid("original_job_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    /** How many attempts the job consumed before terminal failure. */
    attemptCount: integer("attempt_count").notNull(),
    /** Short categorical reason (e.g., 'max-attempts-exceeded', 'non-retryable-error'). */
    failureReason: text("failure_reason").notNull(),
    lastError: text("last_error"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Snapshot of `job_queue.metadata` at time of move. */
    originalMetadata: jsonb("original_metadata"),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (t) => [
    index("job_queue_dead_letter_kind_idx").on(t.kind, t.failedAt.desc()),
    index("job_queue_dead_letter_failed_at_idx").on(t.failedAt.desc()),
  ],
);

export type JobStatus = "pending" | "processing" | "succeeded" | "failed";
