"use client";

import { StandardConfirmDialog } from "@/components/standard/standard-confirm-dialog";

/**
 * Clickable "Modified" badge for saved-view pages.
 *
 * Renders nothing when the view is unmodified. When the current view
 * state differs from the loaded saved-view definition (column,
 * filter, sort, or search drift detected by the parent page), the
 * badge becomes visible. Clicking it opens a confirm dialog; on
 * confirm, the parent's `onReset` callback runs — typically a
 * fire-and-forget audit-emitting server action plus a router
 * navigation back to the canonical `?view=<id>` URL.
 *
 * Visual styling preserves the prior inline implementation 1:1
 * (rounded-full pill, priority-medium tokens). Adopting pages should
 * pass the saved view's display name so the confirm dialog reads
 * naturally.
 */
export interface ModifiedBadgeProps {
  /** Whether the current view state differs from the stored saved view. */
  isModified: boolean;
  /** Saved view display name (used in the confirm dialog body). */
  savedViewName: string;
  /**
   * Optional list of modified dimensions (columns / filters / sort /
   * search). Reserved for future copy adjustments; not rendered today.
   */
  modifiedFields?: string[];
  /**
   * Called when the user confirms reset. Fire-and-forget; the parent
   * handles audit + navigation.
   */
  onReset: () => void | Promise<void>;
}

export function ModifiedBadge({
  isModified,
  savedViewName,
  onReset,
}: ModifiedBadgeProps) {
  if (!isModified) return null;

  return (
    <StandardConfirmDialog
      trigger={
        <button
          type="button"
          aria-label={`Reset view to ${savedViewName}`}
          aria-haspopup="dialog"
          className="rounded-full border border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--priority-medium-fg)] transition hover:bg-[var(--priority-medium-bg)]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
        >
          Modified
        </button>
      }
      title="Reset view?"
      body={`Discard your changes and restore "${savedViewName}".`}
      confirmLabel="Reset"
      cancelLabel="Cancel"
      tone="primary"
      onConfirm={async () => {
        await onReset();
      }}
    />
  );
}
