import "server-only";
import type { JobKind, JobHandler, JobPayloadFor, JobHandlerContext } from "../types";
import { blobCleanupHandler } from "./blob-cleanup";

/**
 * Handler registry — single source of truth for `JobKind` → handler dispatch.
 *
 * The `satisfies` clause makes the compiler enforce two invariants:
 *   1. Every `JobKind` has a registered handler (exhaustive coverage).
 *   2. Each registered handler's payload type matches its `JobKind`.
 *
 * Add a handler in three steps:
 *   1. Extend `JobKind` in `src/lib/jobs/types.ts`.
 *   2. Add the payload shape to `JobPayloadByKind` in the same file.
 *   3. Implement the handler in `src/lib/jobs/handlers/<kind>.ts` and add
 *      its import + map entry below. The compiler will fail until the
 *      handler is registered.
 *
 * The map is typed as a discriminated lookup so `handlers[job.kind]` in the
 * worker narrows correctly to `JobHandler<typeof job.kind>` — no runtime
 * casts in the dispatch path.
 */

/**
 * The map shape every handler dispatcher reads. Keys are `JobKind`, values
 * are the matching `JobHandler<K>`.
 */
type HandlerMap = { [K in JobKind]: JobHandler<K> };

/**
 * Registry map. The `satisfies HandlerMap` clause guarantees compile-time
 * exhaustiveness — adding a new `JobKind` without registering its handler
 * fails the build.
 */
export const handlers = {
  "blob-cleanup": blobCleanupHandler,
} as const satisfies HandlerMap;

/**
 * Type-safe dispatch helper. Pulls the handler for a kind and invokes it
 * with a payload guaranteed to match. Worker code uses this rather than
 * indexing `handlers` directly so the narrowing stays in one place.
 */
export async function dispatchJob<K extends JobKind>(
  kind: K,
  payload: JobPayloadFor<K>,
  context: JobHandlerContext,
): Promise<void> {
  const handler = handlers[kind] as JobHandler<K>;
  await handler(payload, context);
}
