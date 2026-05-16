"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import {
  SUPPRESSION_TYPES,
  type MarketingSuppressionRow,
  type SuppressionType,
} from "@/lib/marketing/suppressions-types";
import { AddSuppressionDialog } from "./add-suppression-dialog";
import { RemoveSuppressionButton } from "./remove-suppression-button";

interface SuppressionsListClientProps {
  timePrefs: TimePrefs;
  canAdd: boolean;
  canRemove: boolean;
}

interface SuppressionsFilters {
  q: string;
  source: SuppressionType | "all";
}

const EMPTY_FILTERS: SuppressionsFilters = {
  q: "",
  source: "all",
};

const SOURCE_OPTIONS: ReadonlyArray<{
  value: SuppressionsFilters["source"];
  label: string;
}> = [
  { value: "all", label: "All sources" },
  { value: "unsubscribe", label: "Unsubscribe" },
  { value: "group_unsubscribe", label: "Group unsubscribe" },
  { value: "bounce", label: "Bounce" },
  { value: "block", label: "Block" },
  { value: "spamreport", label: "Spam report" },
  { value: "invalid", label: "Invalid" },
  { value: "manual", label: "Manual" },
];

export function SuppressionsListClient({
  timePrefs,
  canAdd,
  canRemove,
}: SuppressionsListClientProps) {
  // Hydrate `source` from the `?source=` query param so bookmarks and
  // existing tests that navigate to `?source=manual` still scope the
  // list correctly. URL is read once on mount; the user's in-page
  // selection takes over after that (the page does not push back to
  // the URL — fully client state from here).
  const searchParams = useSearchParams();
  const initialFilters = useMemo<SuppressionsFilters>(() => {
    const raw = searchParams?.get("source");
    if (raw && SUPPRESSION_TYPES.includes(raw as SuppressionType)) {
      return { ...EMPTY_FILTERS, source: raw as SuppressionType };
    }
    return EMPTY_FILTERS;
    // Only re-evaluate when the URL changes — but the page server
    // shell remounts on a hard nav, so this dep array is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [filters, setFilters] = useState<SuppressionsFilters>(initialFilters);
  const [draft, setDraft] = useState<SuppressionsFilters>(initialFilters);
  // Bumps after every successful add/remove. Folded into the TanStack
  // queryKey so the infinite-scroll list refetches from cursor=null
  // when the underlying data changes — server `revalidatePath` doesn't
  // reach this client-fetched list.
  const [reloadKey, setReloadKey] = useState(0);
  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

  const memoizedFilters = useMemo<SuppressionsFilters>(
    () => filters,
    [filters],
  );

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: SuppressionsFilters,
    ): Promise<StandardListPagePage<MarketingSuppressionRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.source !== "all") params.set("source", f.source);
      const res = await fetch(
        `/api/marketing/suppressions/list?${params.toString()}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (!res.ok) {
        throw new Error(`Could not load suppressions (${res.status})`);
      }
      const json = (await res.json()) as {
        data: Array<
          Omit<MarketingSuppressionRow, "suppressedAt" | "syncedAt"> & {
            suppressedAt: string;
            syncedAt: string;
          }
        >;
        nextCursor: string | null;
        total: number;
      };
      return {
        data: json.data.map((r) => ({
          ...r,
          suppressedAt: new Date(r.suppressedAt),
          syncedAt: new Date(r.syncedAt),
        })),
        nextCursor: json.nextCursor,
        total: json.total,
      };
    },
    [],
  );

  const renderRow = useCallback(
    (row: MarketingSuppressionRow) => (
      <SuppressionsDesktopRow
        row={row}
        timePrefs={timePrefs}
        canRemove={canRemove}
        onRemoved={bumpReload}
      />
    ),
    [timePrefs, canRemove, bumpReload],
  );

  const renderCard = useCallback(
    (row: MarketingSuppressionRow) => (
      <SuppressionsMobileCard
        row={row}
        timePrefs={timePrefs}
        canRemove={canRemove}
        onRemoved={bumpReload}
      />
    ),
    [timePrefs, canRemove, bumpReload],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q || filters.source !== "all",
  );

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="space-y-3"
    >
      {/* Mobile chip row: edge-fade mask hints overflow when chips
          exceed viewport width. Desktop layout (wrap, no overflow)
          resets the mask via md:[mask-image:none]. Touch targets are
          h-11 (44px) per WCAG 2.5.5. */}
      <div
        className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0 md:[mask-image:none]"
      >
        <input
          type="search"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyDraft();
            }
          }}
          placeholder="Search email"
          className="h-11 min-w-[220px] flex-1 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
        />
        {/* Source select auto-applies on change (preserved from prior
            behavior — the page treats source as a primary scope, not a
            staged filter). */}
        <select
          value={draft.source}
          onChange={(e) => {
            const next = {
              ...draft,
              source: e.target.value as SuppressionsFilters["source"],
            };
            setDraft(next);
            setFilters(next);
          }}
          className={
            draft.source !== "all"
              ? "h-11 min-w-0 shrink-0 appearance-none rounded-full border border-primary/30 bg-primary/15 px-4 pr-8 text-sm font-medium text-foreground transition focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3 md:pr-7"
              : "h-11 min-w-0 shrink-0 appearance-none rounded-full border border-border bg-muted/40 px-4 pr-8 text-sm font-medium text-muted-foreground transition focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3 md:pr-7"
          }
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="hidden h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 md:inline-flex md:items-center"
        >
          Apply
        </button>
        {filtersAreModified ? (
          <button
            type="button"
            onClick={clearFilters}
            className="h-11 shrink-0 rounded-full px-4 text-sm text-muted-foreground hover:text-foreground/90 md:rounded-md md:border md:border-border md:bg-muted/40"
          >
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );

  // Desktop column header. 6 cells when canRemove (5 otherwise). The
  // Remove action cell stays as the trailing actions column when
  // present; matches desktop row layout exactly.
  const SUPPRESSION_COLS = canRemove ? 6 : 5;
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-xs font-medium uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${SUPPRESSION_COLS * 140 + 40}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Email
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Source
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Reason
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Suppressed
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Added by
      </div>
      {canRemove ? (
        <div
          className="min-w-0 flex-1 truncate px-5 py-3 text-right"
          style={{ flexBasis: "140px" }}
        >
          Action
        </div>
      ) : null}
    </div>
  );

  return (
    <StandardListPage<MarketingSuppressionRow, SuppressionsFilters>
      entityType="marketing_suppression"
      queryKey={["marketing-suppressions", reloadKey]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={120}
      emptyState={
        <StandardEmptyState
          title="No suppressed addresses match"
          description={
            filtersAreModified
              ? "Try a different filter."
              : "All recipients are receiving marketing email."
          }
        />
      }
      header={{
        title: "Suppressions",
        description:
          "Mirror of SendGrid's suppression list, reconciled hourly. Admins can manually suppress or re-subscribe an address from here.",
        actions: canAdd ? <AddSuppressionDialog onAdded={bumpReload} /> : undefined,
      }}
      filtersSlot={filtersSlot}
      columnHeaderSlot={columnHeaderSlot}
    />
  );
}

function SuppressionsDesktopRow({
  row,
  timePrefs,
  canRemove,
  onRemoved,
}: {
  row: MarketingSuppressionRow;
  timePrefs: TimePrefs;
  canRemove: boolean;
  onRemoved?: () => void;
}) {
  // Cell count matches column header (6 when canRemove, else 5).
  const cols = canRemove ? 6 : 5;
  const minRowWidth = cols * 140 + 40;
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
      style={{ minWidth: `${minRowWidth}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 font-mono text-xs text-foreground"
        style={{ flexBasis: "140px" }}
      >
        {row.email}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        {row.suppressionType}
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
        title={row.reason ?? undefined}
      >
        {row.reason ?? "—"}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        <UserTimeClient value={row.suppressedAt} prefs={timePrefs} />
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        {row.addedByName ?? (
          <span className="italic text-muted-foreground/70">system</span>
        )}
      </div>
      {canRemove ? (
        <div
          className="min-w-0 flex-1 px-5 py-3 text-right"
          style={{ flexBasis: "140px" }}
        >
          <RemoveSuppressionButton
            email={row.email}
            source={row.suppressionType}
            suppressedAt={row.suppressedAt.toISOString()}
            onRemoved={onRemoved}
          />
        </div>
      ) : null}
    </div>
  );
}

function SuppressionsMobileCard({
  row,
  timePrefs,
  canRemove,
  onRemoved,
}: {
  row: MarketingSuppressionRow;
  timePrefs: TimePrefs;
  canRemove: boolean;
  onRemoved?: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {row.email}
        </span>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {row.suppressionType}
        </span>
      </div>
      {row.reason ? (
        <div className="text-xs text-muted-foreground">{row.reason}</div>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <UserTimeClient value={row.suppressedAt} prefs={timePrefs} />
        <span>
          {row.addedByName ?? (
            <span className="italic text-muted-foreground/70">system</span>
          )}
        </span>
      </div>
      {canRemove ? (
        <div className="mt-1">
          <RemoveSuppressionButton
            email={row.email}
            source={row.suppressionType}
            suppressedAt={row.suppressedAt.toISOString()}
            onRemoved={onRemoved}
          />
        </div>
      ) : null}
    </div>
  );
}
