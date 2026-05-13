"use client";

import { useBulkSelection } from "./use-bulk-selection";

/**
 * Banner that bridges the "all loaded" / "all matching" gap. Visible
 * only when the user has selected every loaded row AND the loaded
 * set is smaller than the total result set — at which point the
 * banner offers the upgrade to `all_matching` scope. After the
 * upgrade, the banner switches to a confirmation + clear affordance.
 *
 * Renders nothing when scope is `none` or `individual`, or when
 * loadedCount equals total (no upgrade is possible).
 */
export function BulkSelectionBanner() {
  const { scope, loadedCount, total, dispatch } = useBulkSelection();

  if (scope.kind === "none" || scope.kind === "individual") return null;

  if (scope.kind === "all_loaded") {
    if (loadedCount >= total) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground"
      >
        <span>
          {`All ${loadedCount.toLocaleString()} on this view selected`}
        </span>
        <button
          type="button"
          onClick={() =>
            dispatch({ type: "select_all_matching", estimatedTotal: total })
          }
          className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {`Select all ${total.toLocaleString()} matching`}
        </button>
      </div>
    );
  }

  // scope.kind === "all_matching"
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground"
    >
      <span>
        {`All ${scope.estimatedTotal.toLocaleString()} matching items selected`}
      </span>
      <button
        type="button"
        onClick={() => dispatch({ type: "clear" })}
        className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Clear selection
      </button>
    </div>
  );
}
