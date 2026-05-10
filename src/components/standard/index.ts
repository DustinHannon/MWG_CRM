/**
 * Phase 24 §3.4 / §5.4 — standard component primitives.
 *
 * Import from "@/components/standard" rather than the per-file paths
 * so future renames stay tractable.
 */
export { StandardEmptyState, type StandardEmptyStateProps } from "./standard-empty-state";
export { StandardPageHeader, type StandardPageHeaderProps } from "./standard-page-header";
export {
  StandardDetailHeader,
  type StandardDetailHeaderProps,
} from "./standard-detail-header";
export { StandardListPage, type StandardListPageProps } from "./standard-list-page";
export {
  StandardLoadingState,
  type StandardLoadingStateProps,
} from "./standard-loading-state";
export {
  StandardErrorBoundary,
  type StandardErrorBoundaryProps,
} from "./standard-error-boundary";
export {
  StandardConfirmDialog,
  type StandardConfirmDialogProps,
} from "./standard-confirm-dialog";
