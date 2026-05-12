import type { ReactNode } from "react";
import { StandardEmptyState } from "./standard-empty-state";
import {
  StandardPageHeader,
  type StandardPageHeaderProps,
} from "./standard-page-header";

/**
 * / §5.4 — canonical list-page shell.
 *
 * Slot-based wrapper for the common pattern: header + optional filter
 * row + body (table OR empty state). When `isEmpty` is true the body
 * slot is replaced with a <StandardEmptyState>. The shell does not
 * manage data fetching or pagination — those stay in the page-level
 * server component where each entity has different filter / cursor
 * semantics.
 *
 * Pages with significantly bespoke layouts (the leads list, the leads
 * pipeline) intentionally do NOT migrate to this shell — forcing them
 * through it would damage their view-toolbar / pipeline-board patterns.
 * Use this for newer list pages that don't have a custom shape yet,
 * and for the marketing list pages where the body is a simple table
 * surrounded by a card.
 */
export interface StandardListPageProps {
  /** Header props forwarded to <StandardPageHeader />. */
  header: StandardPageHeaderProps;
  /** Filter bar rendered between header and body. Optional. */
  filters?: ReactNode;
  /** Body slot — table, card list, etc. */
  children: ReactNode;
  /**
   * When true the body slot is replaced with `emptyState`. Pages with
   * complex empty/non-empty branching should leave this undefined and
   * render their own conditional inside `children`.
   */
  isEmpty?: boolean;
  /** Custom empty state. Required when `isEmpty` is true. */
  emptyState?: ReactNode;
  /** Optional footer (pagination, totals row, etc). */
  footer?: ReactNode;
  className?: string;
}

export function StandardListPage({
  header,
  filters,
  children,
  isEmpty,
  emptyState,
  footer,
  className,
}: StandardListPageProps) {
  return (
    <div className={["space-y-3", className ?? ""].filter(Boolean).join(" ")}>
      <StandardPageHeader {...header} />
      {filters ? <div>{filters}</div> : null}
      {isEmpty ? (
        emptyState ?? (
          <StandardEmptyState
            title="Nothing to show yet"
            description="Add your first record to see it here."
          />
        )
      ) : (
        children
      )}
      {footer ? <div>{footer}</div> : null}
    </div>
  );
}
