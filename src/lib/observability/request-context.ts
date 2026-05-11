import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Phase 25 §4.3 — Per-request context propagated via AsyncLocalStorage.
 *
 * Every server entry point (server action via `withErrorBoundary`,
 * public REST handler via `withApi`, cron route, webhook receiver)
 * runs its body inside `runWithRequestContext({ requestId }, ...)`
 * so any nested `writeAudit`, `writeSystemAudit`, or `logger.*` call
 * automatically picks up the request id without each caller threading
 * it through every function signature.
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
 * Read the current user id from the context, if set.
 */
export function getContextUserId(): string | undefined {
  return storage.getStore()?.userId;
}

/**
 * Read the full current context (for advanced cases that need both
 * fields at once).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Update the current context's user id in place. Used after the
 * authentication step resolves the principal; the request id was
 * already set at request entry.
 *
 * Calling this outside an active `runWithRequestContext` scope is a
 * no-op (no store to mutate). It's intentionally permissive — the
 * audit/logger code paths that auto-pull from context handle the
 * undefined case gracefully.
 */
export function setContextUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
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
