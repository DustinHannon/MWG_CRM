"use client";

import { X } from "lucide-react";
import { type ReactNode } from "react";
import { useBulkSelection } from "./use-bulk-selection";

/**
 * Sticky action toolbar shown whenever the selection scope is not
 * `none`. Renders a count summary on the left and a slot for action
 * buttons on the right. Action buttons consume the scope via
 * `useBulkSelection` directly so the toolbar stays slot-agnostic.
 *
 * Position: a fixed-position container at the bottom of the viewport
 * so it doesn't move with the virtualized scroll. Width caps at the
 * page content (`max-w-3xl`) and centers; mobile is full-width minus
 * a small margin.
 */
export function BulkActionToolbar({ children }: { children?: ReactNode }) {
  const { scope, dispatch } = useBulkSelection();

  if (scope.kind === "none") return null;

  const summary = (() => {
    switch (scope.kind) {
      case "individual":
        return `${scope.ids.size.toLocaleString()} selected`;
      case "all_loaded":
        return "All on this view selected";
      case "all_matching":
        return `All ${scope.estimatedTotal.toLocaleString()} matching selected`;
    }
  })();

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="pointer-events-none fixed inset-x-2 bottom-4 z-20 flex justify-center md:inset-x-0"
    >
      <div className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
        <span className="font-medium">{summary}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {children}
          <button
            type="button"
            onClick={() => dispatch({ type: "clear" })}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" aria-hidden />
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
