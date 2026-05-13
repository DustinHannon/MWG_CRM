/**
 * Server-side scope expansion for bulk operations over virtualized
 * infinite lists.
 *
 * The client selection state machine (`SelectionScope` in
 * `@/components/bulk-selection`) has four states; the two that need
 * server-side expansion are `individual` (explicit id list) and
 * `all_matching` (filter set, no id list — the server walks pages).
 *
 * This module owns the expansion contract. Callers inject the
 * concrete `fetchPage` and `fetchByIds` functions so the helper
 * stays decoupled from any specific entity. That avoids the
 * dispatch-ordering hazard where this file would otherwise have to
 * import every entity's cursor function.
 *
 * The iterator yields batches (full pages) so callers can apply
 * actions in chunks and stream progress without buffering the full
 * result set in memory.
 */

/** The bulk-scope discriminator passed across the server boundary. */
export type BulkScope =
  | { kind: "ids"; ids: string[] }
  | {
      kind: "filtered";
      filters: unknown;
      entity: "lead" | "account" | "contact" | "opportunity" | "task";
    };

/**
 * Page loader contract. Matches `StandardListPagePage` shape but is
 * redeclared here so this module has no dependency on the React UI
 * component.
 */
export interface BulkScopePage<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Iterate the rows covered by a bulk scope, yielding one batch per
 * page. For `{ kind: "ids" }` the helper batches the id list and
 * calls `fetchByIds`. For `{ kind: "filtered" }` the helper walks
 * pages via `fetchPage` until exhaustion.
 *
 * Yielding by batch (rather than row) lets callers:
 *   - Apply an action per-batch with `Promise.all` over the batch.
 *   - Audit per-batch (one summary audit row per page rather than
 *     per row) when the per-row volume justifies aggregation.
 *   - Track progress for long-running operations.
 *
 * Pass `idBatchSize` to control the chunk size for the `ids` path
 * (default 200 — matches the historic `bulkTagEntities` limit
 * without forcing all callers to bundle).
 */
export async function* iterateBulkScope<T>(
  scope: BulkScope,
  fetchPage: (
    cursor: string | null,
    filters: unknown,
  ) => Promise<BulkScopePage<T>>,
  fetchByIds: (ids: string[]) => Promise<T[]>,
  idBatchSize: number = 200,
): AsyncGenerator<T[]> {
  if (scope.kind === "ids") {
    for (let i = 0; i < scope.ids.length; i += idBatchSize) {
      const batch = scope.ids.slice(i, i + idBatchSize);
      const rows = await fetchByIds(batch);
      if (rows.length > 0) yield rows;
    }
    return;
  }

  // scope.kind === "filtered"
  let cursor: string | null = null;
  while (true) {
    const page = await fetchPage(cursor, scope.filters);
    if (page.data.length > 0) yield page.data;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}

/**
 * Convenience: collect every row covered by a scope into a single
 * array. Use only when the action genuinely needs the full id list
 * in memory (e.g., to compute a single audit summary). Otherwise
 * prefer `iterateBulkScope` directly so memory stays bounded.
 */
export async function collectBulkScope<T>(
  scope: BulkScope,
  fetchPage: (
    cursor: string | null,
    filters: unknown,
  ) => Promise<BulkScopePage<T>>,
  fetchByIds: (ids: string[]) => Promise<T[]>,
  idBatchSize: number = 200,
): Promise<T[]> {
  const out: T[] = [];
  for await (const batch of iterateBulkScope(
    scope,
    fetchPage,
    fetchByIds,
    idBatchSize,
  )) {
    out.push(...batch);
  }
  return out;
}
