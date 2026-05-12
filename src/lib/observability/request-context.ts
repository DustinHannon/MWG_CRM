import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated via AsyncLocalStorage.
 *
 * Covered surfaces (as of 62039fc):
 * Server actions via `withErrorBoundary` (src/lib/server-action.ts)
 * Public REST routes via `withApi` (src/lib/api/handler.ts)
 *
 * NOT covered yet — direct route handlers in these paths still write
 * audit rows with `request_id = null`:
 * /api/cron/* cron jobs
 * /api/admin/* admin route handlers (e.g. email-failures retry)
 * /api/health — health probe
 * /api/v1/security/csp-report — CSP violation receiver
 * /api/v1/webhooks/sendgrid/events — SendGrid webhook
 *
 * Extending coverage is mechanical: wrap the handler body with
 * `runWithRequestContext({ requestId: newRequestId() }, () => ...)`.
 * Tracked as a follow-up; not blocking.
 *
 * The contract: any helper that reads `getRequestId()` outside a
 * `runWithRequestContext` scope receives `undefined` — callers should
 * treat that gracefully (audit rows fall back to null, logger lines
 * omit the field).
 *
 * The data is server-only — node:async_hooks doesn't exist in browser
 * runtimes; `"server-only"` enforces this at module-resolution time.
 *
 * Why AsyncLocalStorage instead of a thread-local: Node has no thread-
 * local. ALS gives us the same semantics: a context cell that
 * automatically follows the async causality chain (awaits, timers,
 * promises) without explicit parameter threading.
 */

export interface RequestContext {
  /** Short URL-safe correlation id; same value lands in every log line + audit row for one logical request. */
  requestId: string;
  /** Optional auth-resolved user id. Not always populated (pre-auth code paths). */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Read the current request id, if any. Returns undefined when called
 * outside a `runWithRequestContext` scope (e.g. module-init code,
 * background jobs that didn't opt in).
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Run `fn` with the supplied context. Any async work spawned from
 * `fn` inherits the same context until completion.
 */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}
