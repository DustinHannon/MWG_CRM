/**
 * Bulk selection state machine — shared types.
 *
 * Selection over a virtualized infinite list has four distinct states:
 *
 *   1. `none` — no rows selected. Toolbar and banner are hidden.
 *   2. `individual` — explicit per-row selection. The user has
 *      clicked checkboxes on specific rows. `ids` is the authoritative
 *      set.
 *   3. `all_loaded` — every row currently materialized in the
 *      virtualizer is selected. New pages fetched after this point
 *      are NOT automatically added (would silently change scope).
 *      Banner offers the upgrade to `all_matching`.
 *   4. `all_matching` — every row matching the active filter set,
 *      including rows not yet loaded. Bulk actions iterate
 *      server-side via `iterateBulkScope` rather than the loaded ID
 *      array.
 *
 * The provider owns the state machine; pages dispatch transitions.
 * Filter changes should dispatch `{ type: "clear" }` to reset scope
 * to `none` (the provider does not subscribe to filter state — that
 * coupling lives at the consumer).
 */

export type SelectionScope =
  | { kind: "none" }
  | { kind: "individual"; ids: ReadonlySet<string> }
  | { kind: "all_loaded" }
  | { kind: "all_matching"; estimatedTotal: number };

export interface SelectionState {
  scope: SelectionScope;
  /** Count of rows currently materialized in the virtualizer. */
  loadedCount: number;
  /** Server-reported total matching the active filters. */
  total: number;
}

export type SelectionAction =
  | { type: "toggle_individual"; id: string }
  | { type: "select_all_loaded" }
  | { type: "select_all_matching"; estimatedTotal: number }
  | { type: "clear" }
  | { type: "sync_load_state"; loadedCount: number; total: number };

export interface SelectionContextValue extends SelectionState {
  dispatch: (action: SelectionAction) => void;
  /** Convenience predicate; returns true when the row participates in the current scope. */
  isSelected: (id: string) => boolean;
}
