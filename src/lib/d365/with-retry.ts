import "server-only";
import { logger } from "@/lib/logger";

/**
 * retry wrapper for D365 OData calls.
 *
 * Mirrors the v2 d365_sync.py retry semantics:
 * max 3 retries
 * exponential backoff (1s, 2s, 4s) capped at 30s
 * honors `Retry-After` on 429 (verbatim, capped at 60s)
 * retries on 429, 503, 504, network/timeout
 * does NOT retry on 400, 401, 403, 404 (caller handles 401 by
 * invalidating cached token before retrying once)
 *
 * The wrapped function should throw `D365HttpError` for HTTP failures
 * so this wrapper can decide based on status. Other errors (network,
 * timeout, abort) bubble through and trigger a backoff retry.
 */

export interface D365RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onRetry?: (attempt: number, error: unknown, backoffMs: number) => void;
}

export class D365HttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly responseBody?: string;
  constructor(
    status: number,
    message: string,
    opts: { retryAfterSeconds?: number; responseBody?: string } = {},
  ) {
    super(message);
    this.name = "D365HttpError";
    this.status = status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.responseBody = opts.responseBody;
  }
}

const RETRYABLE_STATUS = new Set<number>([408, 425, 429, 500, 502, 503, 504]);

export async function withD365Retry<T>(
  fn: () => Promise<T>,
  options: D365RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initial = options.initialBackoffMs ?? 1000;
  const cap = options.maxBackoffMs ?? 30_000;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > maxRetries) throw err;

      const backoff = computeBackoff(err, attempt, initial, cap);
      if (backoff === null) throw err; // non-retryable HTTP status

      options.onRetry?.(attempt, err, backoff);
      logger.warn("d365.retry", {
        attempt,
        backoffMs: backoff,
        errorMessage: err instanceof Error ? err.message : String(err),
        status: err instanceof D365HttpError ? err.status : undefined,
      });
      await sleep(backoff);
    }
  }
}

function computeBackoff(
  err: unknown,
  attempt: number,
  initial: number,
  cap: number,
): number | null {
  if (err instanceof D365HttpError) {
    if (!RETRYABLE_STATUS.has(err.status)) return null;
    if (err.status === 429 && err.retryAfterSeconds) {
      return Math.min(err.retryAfterSeconds * 1000, 60_000);
    }
  }
  // Exponential backoff: initial * 2^(attempt-1), capped.
  return Math.min(initial * 2 ** (attempt - 1), cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
