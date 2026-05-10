import "server-only";

/**
 * Phase 21 — Generic retry wrapper for SendGrid HTTP calls.
 *
 * SendGrid's REST + SMTP APIs return:
 *   - 5xx → transient backend trouble; safe to retry.
 *   - 429 → rate-limit; retry honoring `Retry-After` if present.
 *   - ECONNRESET / ETIMEDOUT (Node net errors) → retry.
 *   - 4xx (other than 429) → caller-side problem; do NOT retry.
 *
 * The retry budget is intentionally small (default 3) — SendGrid is the
 * canary; if it's down, we surface a `failed` campaign status promptly
 * instead of holding a Vercel function open until timeout.
 *
 * Backoff: exponential base 2s (2s, 4s, 8s) with full jitter to avoid
 * hammering SendGrid in lockstep when many campaigns retry at once.
 * If the upstream supplies `Retry-After`, that wins.
 */

interface RetryOptions {
  /** Maximum number of attempts including the initial call. Default 3. */
  maxRetries?: number;
  /** Optional hook for telemetry between retries. */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Errors thrown by `@sendgrid/client` and `@sendgrid/mail` carry a
 * `code` (numeric HTTP status) and a `response` with `headers`. We do
 * not import the library types here to keep this helper portable —
 * structural narrowing is enough.
 */
interface SendGridLikeError {
  code?: number;
  response?: {
    headers?: Record<string, string | string[] | undefined> | Headers;
    body?: unknown;
  };
}

/**
 * Node-level network errors carry a string `code` like ECONNRESET. The
 * sendgrid client surfaces these via the same thrown shape but with
 * `code` as a string instead of an HTTP status number.
 */
interface NodeNetworkError {
  code?: string;
}

const DEFAULT_MAX_RETRIES = 3;
const NODE_RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      const isLastAttempt = attempt >= maxRetries;
      if (!retryable || isLastAttempt) {
        throw err;
      }
      const delayMs = computeDelayMs(err, attempt);
      options.onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop always returns or throws — but TS can't
  // prove that. Throw the last error to satisfy the type system.
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const httpStatus = (err as SendGridLikeError).code;
  if (typeof httpStatus === "number") {
    if (httpStatus >= 500) return true;
    if (httpStatus === 429) return true;
    return false;
  }
  if (typeof httpStatus === "string" && NODE_RETRYABLE_CODES.has(httpStatus)) {
    return true;
  }
  return false;
}

function computeDelayMs(err: unknown, attempt: number): number {
  const retryAfter = readRetryAfterSeconds(err);
  if (retryAfter !== null) {
    // Cap the upstream-suggested delay at 30s so a hostile/buggy
    // header doesn't pin a Vercel function open.
    return Math.min(retryAfter, 30) * 1000;
  }
  // Exponential 2^attempt seconds (2, 4, 8 …) with full jitter.
  const baseSeconds = Math.pow(2, attempt);
  const jitter = Math.random() * baseSeconds;
  return Math.min(jitter * 1000, 30_000);
}

function readRetryAfterSeconds(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as SendGridLikeError).response?.headers;
  if (!headers) return null;
  let raw: string | string[] | undefined;
  if (headers instanceof Headers) {
    raw = headers.get("retry-after") ?? undefined;
  } else {
    raw = (headers as Record<string, string | string[] | undefined>)[
      "retry-after"
    ] ?? (headers as Record<string, string | string[] | undefined>)[
      "Retry-After"
    ];
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Re-export for ergonomic destructured imports in callers that mix
// `withRetry` with other helpers from this barrel.
export type { RetryOptions };
