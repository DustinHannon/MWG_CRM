/**
 * Bulk selection primitives.
 *
 * Pages wire these up in three pieces:
 *
 *   1. Wrap the page in `<BulkSelectionProvider>`.
 *   2. Render `<BulkSelectionBanner />` and `<BulkActionToolbar>` via
 *      the `StandardListPage` `bulkActions` slot (typed as `{ banner,
 *      toolbar }`).
 *   3. Per-row checkboxes call `dispatch({ type: "toggle_individual",
 *      id })` and use `isSelected(id)` for their controlled state.
 *
 * Server-side bulk action execution iterates via
 * `iterateBulkScope` from `@/lib/bulk-actions/scope`. Audit emission
 * happens at the server-action layer, not the client provider.
 */
export { BulkSelectionProvider } from "./bulk-selection-provider";
export { useBulkSelection } from "./use-bulk-selection";
export { BulkSelectionBanner } from "./bulk-selection-banner";
export { BulkActionToolbar } from "./bulk-action-toolbar";
export type {
  SelectionScope,
  SelectionState,
  SelectionAction,
  SelectionContextValue,
} from "./types";
