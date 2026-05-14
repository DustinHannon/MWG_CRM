"use client";

// consistency-exempt: list-page-pattern: archived-page semantics — admin-only
// soft-deleted views surface a Restore + Delete-permanently action pair per
// row instead of an edit affordance; bulk selection is omitted (cron
// purge-archived auto-removes leads at 30 days, page is admin-only and capped
// at ~50 rows per fetch); the header surfaces a single "Back to <entity>"
// navigation link visible on every viewport instead of per-control desktop-
// only affordances; trailing actions cell is widened to ~220 px to fit the
// Restore + Delete-permanently button pair (canonical row-actions cell is
// w-10 for a 3-dot menu).

import { useCallback, type ReactNode } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { DEFAULT_TIME_PREFS, formatUserTime } from "@/lib/format-time";
import { UserChip } from "@/components/user-display/user-chip";
import { ArchivedListMobile } from "./archived-list-mobile";

// Canonical row-width math from the Leads list reference:
// each desktop content cell has min-width 140 px; the trailing actions
// cell is fixed. Archived rows have 4 content cells (title/subtitle,
// archived date, by-user, reason) plus the wider actions cell. The row
// container AND the column-header tier share this min-width so both
// horizontally scroll together inside StandardListPage's overflow-x-auto
// wrapper.
const ARCHIVED_CONTENT_COLS = 4;
const ARCHIVED_CELL_BASIS_PX = 140;
const ARCHIVED_ACTIONS_WIDTH_PX = 220;
const ARCHIVED_ROW_MIN_WIDTH_PX =
  ARCHIVED_CONTENT_COLS * ARCHIVED_CELL_BASIS_PX + ARCHIVED_ACTIONS_WIDTH_PX;

/**
 * Generic shape every archived row honours. Each entity surfaces the
 * same 5 audit columns plus an entity-specific title/subtitle pair so
 * the same client component renders all five archive views.
 */
export interface ArchivedRow {
  id: string;
  title: string;
  subtitle: string | null;
  deletedAt: Date | string | null;
  reason: string | null;
  deletedById: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
}

/**
 * Server-action shapes the client wraps in `<form>` submission.
 * Each consumer page passes the imported action references through
 * so the form posts directly to the canonical action without an
 * additional client round-trip.
 */
type ArchivedAction = (formData: FormData) => Promise<unknown>;

export interface ArchivedListClientProps {
  /** Header H1 — e.g. "Archived leads". */
  headerTitle: string;
  /** Header subtitle — short factual sentence. */
  headerDescription: string;
  /** Trailing header action cluster — typically a back-link. */
  headerActions?: ReactNode;
  /** Entity label rendered in the secondary-column table header. */
  subtitleHeader: string;
  /** Fetch URL — e.g. `/api/leads/archived`. The client builds the cursor query param itself. */
  fetchUrl: string;
  /** TanStack Query key segment to differentiate the cache. */
  queryKey: string;
  /** Restore server action; receives a FormData with `id` set. */
  restoreAction: ArchivedAction;
  /** Hard-delete server action; receives a FormData with `id` set. */
  hardDeleteAction: ArchivedAction;
  /** Empty-state message rendered when no archived rows exist. */
  emptyMessage: string;
}

/**
 * Canonical client list for the five admin archive views (leads,
 * accounts, contacts, opportunities, tasks). Wires StandardListPage's
 * infinite-scroll shell to a cursor-paginated /api endpoint and
 * renders the per-row Restore / Delete permanently actions inline.
 *
 * Bulk-selection is intentionally omitted: archive views are rarely
 * bulk-acted on (the cron `purge-archived` auto-removes leads after
 * 30 days). The page is admin-only and capped at ~50 rows per fetch.
 */
export function ArchivedListClient({
  headerTitle,
  headerDescription,
  headerActions,
  subtitleHeader,
  fetchUrl,
  queryKey,
  restoreAction,
  hardDeleteAction,
  emptyMessage,
}: ArchivedListClientProps) {
  const fetchPage = useCallback(
    async (
      cursor: string | null,
    ): Promise<StandardListPagePage<ArchivedRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(
        `${fetchUrl}${params.toString() ? `?${params.toString()}` : ""}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Could not load archived items (${res.status})`);
      }
      const body = (await res.json()) as StandardListPagePage<ArchivedRow>;
      return body;
    },
    [fetchUrl],
  );

  const renderRow = useCallback(
    (row: ArchivedRow) => (
      <ArchivedDesktopRow
        row={row}
        subtitleHeader={subtitleHeader}
        restoreAction={restoreAction}
        hardDeleteAction={hardDeleteAction}
      />
    ),
    [subtitleHeader, restoreAction, hardDeleteAction],
  );

  const renderCard = useCallback(
    (row: ArchivedRow) => (
      <ArchivedListMobile
        rows={[
          {
            id: row.id,
            title: row.title,
            subtitle: row.subtitle,
            deletedAt: row.deletedAt,
            deletedByName: row.deletedByName,
            deletedByEmail: row.deletedByEmail,
            reason: row.reason,
          },
        ]}
        renderActions={() => (
          <ArchivedRowActions
            id={row.id}
            restoreAction={restoreAction}
            hardDeleteAction={hardDeleteAction}
          />
        )}
      />
    ),
    [restoreAction, hardDeleteAction],
  );

  // Desktop column-header tier. The shell renders this inside its
  // horizontal-scroll wrapper so it stays aligned with row cells when
  // the table is wider than the viewport. Non-sticky — the shell's
  // chrome group above stays sticky for deep-scroll context.
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-[10px] uppercase tracking-wide text-muted-foreground/70"
      style={{ minWidth: `${ARCHIVED_ROW_MIN_WIDTH_PX}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-2"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        {subtitleHeader}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-2"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        Archived
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-2"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        By
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-2"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        Reason
      </div>
      <div
        className="shrink-0 px-2 py-2"
        style={{ width: `${ARCHIVED_ACTIONS_WIDTH_PX}px` }}
      >
        <span className="sr-only">Actions</span>
      </div>
    </div>
  );

  return (
    <StandardListPage<ArchivedRow, Record<string, never>>
      queryKey={[queryKey]}
      fetchPage={fetchPage}
      filters={{}}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={72}
      cardEstimateSize={120}
      emptyState={<StandardEmptyState title={emptyMessage} />}
      header={{
        title: headerTitle,
        description: headerDescription,
        actions: headerActions,
      }}
      columnHeaderSlot={columnHeaderSlot}
    />
  );
}

function ArchivedDesktopRow({
  row,
  subtitleHeader,
  restoreAction,
  hardDeleteAction,
}: {
  row: ArchivedRow;
  subtitleHeader: string;
  restoreAction: ArchivedAction;
  hardDeleteAction: ArchivedAction;
}) {
  // Match the column-header tier's min-width so cells stay aligned with
  // header cells when the table is wider than the viewport. Each
  // content cell uses `flex-basis: 140 px` so cells don't squeeze below
  // 140 px each — canonical row sizing from the Leads reference.
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      style={{ minWidth: `${ARCHIVED_ROW_MIN_WIDTH_PX}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        <div className="truncate font-medium text-foreground">
          {row.title}
        </div>
        {row.subtitle ? (
          <div className="truncate text-xs text-muted-foreground">
            {subtitleHeader}: {row.subtitle}
          </div>
        ) : null}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-xs text-muted-foreground"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        <span>{formatUserTime(row.deletedAt, DEFAULT_TIME_PREFS, "date")}</span>
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-xs"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        {row.deletedById ? (
          <UserChip
            user={{
              id: row.deletedById,
              displayName: row.deletedByName,
              photoUrl: null,
            }}
          />
        ) : (
          <span className="text-muted-foreground">
            {row.deletedByEmail ?? "—"}
          </span>
        )}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-xs text-muted-foreground"
        style={{ flexBasis: `${ARCHIVED_CELL_BASIS_PX}px` }}
      >
        <span className="truncate">{row.reason ?? "—"}</span>
      </div>
      <div
        className="flex shrink-0 items-center gap-2 px-2 py-3"
        style={{ width: `${ARCHIVED_ACTIONS_WIDTH_PX}px` }}
      >
        <ArchivedRowActions
          id={row.id}
          restoreAction={restoreAction}
          hardDeleteAction={hardDeleteAction}
        />
      </div>
    </div>
  );
}

function ArchivedRowActions({
  id,
  restoreAction,
  hardDeleteAction,
}: {
  id: string;
  restoreAction: ArchivedAction;
  hardDeleteAction: ArchivedAction;
}) {
  // React 19's typed `<form action>` wants `Promise<void>`; the server
  // actions return the canonical `ActionResult` envelope. Wrap both
  // through a void-typed adapter so the call still posts directly.
  const wrap = (fn: ArchivedAction) => async (fd: FormData) => {
    await fn(fd);
  };
  return (
    <>
      <form action={wrap(restoreAction)}>
        <input type="hidden" name="id" value={id} />
        <button
          type="submit"
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 hover:bg-muted"
        >
          Restore
        </button>
      </form>
      <form action={wrap(hardDeleteAction)}>
        <input type="hidden" name="id" value={id} />
        <button
          type="submit"
          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] hover:bg-destructive/30"
        >
          Delete permanently
        </button>
      </form>
    </>
  );
}
