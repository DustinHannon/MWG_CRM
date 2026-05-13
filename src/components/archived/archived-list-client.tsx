"use client";

import { useCallback, type ReactNode } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { DEFAULT_TIME_PREFS, formatUserTime } from "@/lib/format-time";
import { UserChip } from "@/components/user-display/user-chip";
import { ArchivedListMobile } from "./archived-list-mobile";

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
  return (
    <div className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 text-sm hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">
          {row.title}
        </div>
        {row.subtitle ? (
          <div className="truncate text-xs text-muted-foreground">
            {subtitleHeader}: {row.subtitle}
          </div>
        ) : null}
      </div>
      <div className="hidden w-32 text-xs text-muted-foreground md:block">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Archived
        </div>
        <span>{formatUserTime(row.deletedAt, DEFAULT_TIME_PREFS, "date")}</span>
      </div>
      <div className="hidden w-40 text-xs md:block">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          By
        </div>
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
      <div className="hidden flex-1 truncate text-xs text-muted-foreground md:block">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Reason
        </div>
        <span className="truncate">{row.reason ?? "—"}</span>
      </div>
      <div className="flex shrink-0 gap-2">
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
