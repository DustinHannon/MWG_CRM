import "server-only";
import { del } from "@vercel/blob";
import { logger } from "@/lib/logger";
import { NonRetryableJobError } from "../errors";
import type { JobHandler, JobPayloadFor } from "../types";

/**
 * Handler for the 'blob-cleanup' kind. Deletes the Vercel Blob objects
 * referenced by `payload.pathnames`. The pathnames are pre-gathered at the
 * call site BEFORE the parent DB delete cascades (STANDARDS §19.4.1) — the
 * handler never re-derives them from the join graph, because by the time
 * the worker claims the job the `attachments -> activities -> entity` chain
 * is already gone.
 *
 * Idempotency contract:
 *   - Pure blob-store deletion; no DB state mutations.
 *   - `del()` on an already-deleted blob is observed as a 404. The handler
 *     treats 404 (and the generic "not found" shapes the `@vercel/blob` SDK
 *     surfaces) as success — a re-run after partial success silently no-ops
 *     the already-deleted entries and proceeds to delete the rest.
 *   - The worker may invoke this handler twice on the same payload (claim
 *     succeeds, mark-success fails, stale-claim sweep resurfaces the row).
 *     The second invocation is safe by construction.
 *
 * Failure modes:
 *   - Structurally invalid payload (empty `pathnames`, non-string entry, or
 *     an entry that is the empty string) → `NonRetryableJobError`. The row
 *     moves directly to dead-letter without consuming the retry budget; we
 *     don't burn 5 attempts on a payload no retry will heal.
 *   - Per-pathname `del()` rejection that is NOT a 404 → recorded as a
 *     failure of the batch. The handler aggregates partial failures and
 *     throws a plain `Error` so the queue treats it as retryable; the next
 *     attempt re-issues `del()` for the remaining pathnames (the already-
 *     succeeded ones surface as 404 on the second try and are accepted).
 *   - Total catastrophic Vercel-Blob outage → all 25 pathnames in a batch
 *     fail; the handler throws plain `Error`; retry budget applies.
 *
 * Performance:
 *   - `@vercel/blob`'s `del()` accepts a string or array. For a batch we
 *     iterate `Promise.allSettled` over 25-wide groups so a single 404 in
 *     the batch does not abort the rest. 25 matches the worker batch size
 *     in `types.ts` (WORKER_BATCH_SIZE) — handlers process one job at a
 *     time, but each job's payload may contain many pathnames; this
 *     internal chunk size bounds concurrency within a single invocation.
 *
 * STANDARDS §19.4 (Hard-delete blob cleanup) governs the contract this
 * handler implements; §19.11.3 documents the durability gap it closes.
 */

const INTERNAL_DEL_CHUNK_SIZE = 25;

/** Heuristic: treat 404 / not-found shapes from @vercel/blob as success. */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // The Vercel Blob SDK throws BlobAccessError / BlobNotFoundError variants
  // whose `.message` includes the status text or the literal "not found".
  // We avoid coupling to the concrete class names because they have moved
  // across SDK minor versions; substring match on `.message` is the stable
  // signal.
  return (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("does not exist")
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export const blobCleanupHandler: JobHandler<"blob-cleanup"> = async (
  payload: JobPayloadFor<"blob-cleanup">,
  context,
): Promise<void> => {
  // Validate payload shape. A malformed payload is permanent — no retry
  // will rewrite it. NonRetryableJobError moves the row straight to
  // dead-letter for manual inspection.
  if (!payload || typeof payload !== "object") {
    throw new NonRetryableJobError(
      "blob-cleanup: payload is not an object",
    );
  }
  const { pathnames } = payload;
  if (!Array.isArray(pathnames)) {
    throw new NonRetryableJobError(
      "blob-cleanup: payload.pathnames is not an array",
    );
  }
  // Empty list is a valid no-op, not a failure. The producer may have
  // enqueued before counting (defensive on the call-site side) and we
  // accept it.
  if (pathnames.length === 0) {
    logger.info("jobs.blob_cleanup.empty_payload", {
      jobId: context.jobId,
      attempt: context.attempt,
    });
    return;
  }
  // Per-entry validation. A single bad entry is permanent — refuse the
  // whole job rather than partially delete and leave a structurally
  // broken payload re-running.
  for (const p of pathnames) {
    if (typeof p !== "string" || p.length === 0) {
      throw new NonRetryableJobError(
        `blob-cleanup: payload.pathnames contains a non-string or empty entry (job ${context.jobId})`,
      );
    }
  }

  // Process in INTERNAL_DEL_CHUNK_SIZE batches with Promise.allSettled so a
  // single 404 (treated as success) or transient 5xx (treated as failure)
  // does not abort sibling deletions.
  const batches = chunk(pathnames, INTERNAL_DEL_CHUNK_SIZE);
  let successCount = 0;
  let notFoundCount = 0;
  const failures: { pathname: string; errorMessage: string }[] = [];

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(async (pathname) => {
        await del(pathname);
        return pathname;
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const pathname = batch[i];
      if (r.status === "fulfilled") {
        successCount += 1;
        continue;
      }
      if (isNotFoundError(r.reason)) {
        // Already gone — re-run after partial success, or upstream
        // race where the blob was deleted by something else. Either
        // way it's a success state for this job.
        notFoundCount += 1;
        continue;
      }
      failures.push({
        pathname,
        errorMessage:
          r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  if (failures.length > 0) {
    // Retryable: throw plain Error. The queue records the failure,
    // schedules the next attempt with backoff, and the next run will
    // re-issue del() for every pathname — the already-succeeded ones
    // will 404 on the second pass and be accepted.
    const sample = failures.slice(0, 3).map((f) => f.pathname);
    logger.warn("jobs.blob_cleanup.partial_failure", {
      jobId: context.jobId,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      totalCount: pathnames.length,
      successCount,
      notFoundCount,
      failureCount: failures.length,
      sampleFailedPathnames: sample,
    });
    throw new Error(
      `blob-cleanup: ${failures.length}/${pathnames.length} del() calls failed (sample: ${sample.join(", ")})`,
    );
  }

  // Full success (including the not-found tolerances). Log only the
  // counts; don't log every pathname (PII / volume concern).
  logger.info("jobs.blob_cleanup.completed", {
    jobId: context.jobId,
    attempt: context.attempt,
    totalCount: pathnames.length,
    successCount,
    notFoundCount,
  });
};
