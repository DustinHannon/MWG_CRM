import "server-only";

/**
 * Typed error hierarchy for the durable async job queue (F-Ω-8).
 *
 * These are INFRASTRUCTURE errors thrown across the worker / handler boundary
 * — they never flow back through `withErrorBoundary` to a user surface, so
 * they intentionally do NOT extend `KnownError` (no `publicMessage`, no
 * `ErrorCode`). Handlers throw them, the queue interprets them, and any
 * remaining detail flows to the dead-letter row + structured logs.
 *
 * Why a separate hierarchy (vs. reusing `ConflictError` etc.):
 *   - `KnownError` carries a user-facing message contract. Queue-internal
 *     errors have no user UX. Reusing it would imply a UX path that doesn't
 *     exist and would push toward leaking handler-internal detail into
 *     audit/log strings the wrong way.
 *   - `markJobFailed(jobId, error, retryable)` needs to discriminate "this
 *     was a typed signal from the handler" vs "this was an unexpected
 *     throw". `instanceof JobError` is that discriminator.
 *
 * Used by:
 *   - Handlers (`src/lib/jobs/handlers/*`) — throw `NonRetryableJobError`
 *     for permanent failures (malformed payload, missing dependency the
 *     retry can't fix). Any other throw is interpreted as retryable.
 *   - The worker shell (B3) — throws `JobTimeoutError` when a handler
 *     exceeds its per-invocation budget. Treated as retryable.
 *
 * Handlers MUST NOT throw `KnownError` subclasses. If they do, the queue
 * treats them as generic retryable errors — but the surface naming is wrong
 * (these errors are not "known to the user").
 */

/** Base class for queue-internal errors. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
    // Maintain prototype chain across the down-leveled ES target so
    // `instanceof JobError` works against rethrows. Without this the
    // class extends Error but instanceof returns false in some transpile
    // configurations.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by handlers when the failure is permanent.
 *
 * Examples:
 *   - Payload is structurally invalid (a required pathname is empty).
 *   - An external resource the handler depends on returned a 4xx that
 *     will never succeed (e.g., a malformed blob URL — vs a transient 5xx
 *     which should retry).
 *   - The handler detects a precondition the queue cannot heal by retrying.
 *
 * The queue moves the row directly to dead-letter without consuming further
 * retry budget. `attempt_count` reflects the attempt during which the
 * non-retryable error was raised.
 */
export class NonRetryableJobError extends JobError {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by the worker shell when a handler exceeds its per-invocation
 * execution budget. Treated as RETRYABLE — the next attempt may complete
 * within budget on a warmer lambda, or the handler may have hung on a
 * transient downstream stall.
 *
 * Repeated timeouts exhaust the retry budget normally and land in
 * dead-letter with `failure_reason = 'max-attempts-exceeded'`.
 */
export class JobTimeoutError extends JobError {
  constructor(message: string) {
    super(message);
    this.name = "JobTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
