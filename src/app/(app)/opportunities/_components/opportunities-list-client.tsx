// consistency-exempt: list-page-pattern: numeric range filter pair
// (minAmount/maxAmount) inline in the filter row, and Table↔Pipeline
// toggle via the StandardListPage `controls` slot. Both are documented
// deviations per STANDARDS §17 "Allowed page-specific deviations".

"use client";

import Link from "next/link";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import {
  BulkActionToolbar,
  BulkSelectionBanner,
  BulkSelectionProvider,
  useBulkSelection,
} from "@/components/bulk-selection";
import { BulkTagButton } from "@/components/tags/bulk-tag-button";
import { TagChip } from "@/components/tags/tag-chip";
import { TagsCell } from "@/components/tags/tags-cell";
import { UserChip } from "@/components/user-display/user-chip";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { StatusPill } from "@/components/ui/status-pill";
import { useClickOutside } from "@/hooks/use-click-outside";
import { cn } from "@/lib/utils";
import { type TimePrefs } from "@/lib/format-time";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  type OpportunityColumnKey,
} from "@/lib/opportunity-view-constants";
import type { OpportunityRow } from "@/lib/opportunity-views";
import { OpportunityListMobile } from "./opportunity-list-mobile";
import { OpportunityRowActions } from "./opportunity-row-actions";
import {
  BulkArchiveBar,
  BulkArchiveProvider,
  RowCheckbox,
} from "./bulk-archive";
import { SortableOpportunitiesHeaders } from "./sortable-headers";
import {
  OpportunityViewToolbar,
  type OpportunityViewSummary,
} from "../view-toolbar";

interface AvailableTag {
  id: string;
  name: string;
  color: string | null;
}

interface OwnerOption {
  value: string;
  label: string;
}

interface AccountOption {
  value: string;
  label: string;
}

interface ActorLite {
  id: string;
  isAdmin: boolean;
}

export interface OpportunitiesListClientProps {
  user: ActorLite;
  timePrefs: TimePrefs;
  activeViewParam: string;
  activeViewName: string;
  activeColumns: OpportunityColumnKey[];
  baseColumns: OpportunityColumnKey[];
  views: OpportunityViewSummary[];
  savedDirtyId: string | null;
  subscribedViewIds: string[];
  defaultViewId: string | null;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  accountOptions: AccountOption[];
  canApplyTags: boolean;
}

interface OpportunityFilters {
  q: string;
  owner: string; // comma-separated owner ids
  account: string; // comma-separated account ids
  stage: string; // single stage key
  closingWithinDays: string;
  minAmount: string;
  maxAmount: string;
  tag: string; // comma-separated tag names
}

const EMPTY_FILTERS: OpportunityFilters = {
  q: "",
  owner: "",
  account: "",
  stage: "",
  closingWithinDays: "",
  minAmount: "",
  maxAmount: "",
  tag: "",
};

const STAGE_LABELS: Record<string, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed-won",
  closed_lost: "Closed-lost",
};

const STAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  OPPORTUNITY_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s] ?? s,
  }));

const CLOSING_WITHIN_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  [
    { value: "7", label: "Closing in 7 days" },
    { value: "30", label: "Closing in 30 days" },
    { value: "90", label: "Closing in 90 days" },
  ];

/**
 * Client-side opportunities list. Owns:
 *   - 8-dimension filter state (q, owner, account, stage,
 *     closingWithinDays, minAmount, maxAmount, tag).
 *   - First entity with a numeric range filter pair
 *     (minAmount/maxAmount). Implemented inline pending a 2nd/3rd
 *     occurrence elsewhere — Rule of 3 not yet triggered.
 *   - TanStack Query cache (via StandardListPage's infinite scroll).
 *   - Bulk selection state for bulk-tag via BulkSelectionProvider.
 *   - Bulk archive selection state via BulkArchiveProvider — separate
 *     surface keyed off per-row RowCheckbox in the desktop table.
 *
 * Saved-view + columns + view selection remain server-driven. The
 * server-rendered shell passes `activeViewParam` and `activeColumns`
 * as props; whenever the view changes via URL (the
 * OpportunityViewToolbar pushes `/opportunities?view=...`), Next.js
 * re-renders the server shell which passes new props in. The outer
 * `key={activeViewParam}` forces a remount on view change so filter
 * state resets.
 */
export function OpportunitiesListClient(props: OpportunitiesListClientProps) {
  return (
    <BulkArchiveProvider>
      <BulkSelectionProvider>
        <OpportunitiesListInner {...props} />
      </BulkSelectionProvider>
    </BulkArchiveProvider>
  );
}

function OpportunitiesListInner({
  user,
  timePrefs,
  activeViewParam,
  activeViewName,
  activeColumns,
  baseColumns,
  views,
  savedDirtyId,
  subscribedViewIds,
  defaultViewId,
  allTags,
  ownerOptions,
  accountOptions,
  canApplyTags,
}: OpportunitiesListClientProps) {
  const [filters, setFilters] = useState<OpportunityFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<OpportunityFilters>(EMPTY_FILTERS);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const { dispatch } = useBulkSelection();

  const memoizedFilters = useMemo<OpportunityFilters>(
    () => filters,
    [filters],
  );

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: OpportunityFilters,
      signal?: AbortSignal,
    ): Promise<StandardListPagePage<OpportunityRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("view", activeViewParam);
      params.set("cols", activeColumns.join(","));
      if (f.q) params.set("q", f.q);
      if (f.owner) params.set("owner", f.owner);
      if (f.account) params.set("account", f.account);
      if (f.stage) params.set("stage", f.stage);
      if (f.closingWithinDays)
        params.set("closingWithinDays", f.closingWithinDays);
      if (f.minAmount) params.set("minAmount", f.minAmount);
      if (f.maxAmount) params.set("maxAmount", f.maxAmount);
      if (f.tag) params.set("tag", f.tag);
      const res = await fetch(`/api/opportunities/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) {
        throw new Error(`Could not load opportunities (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<OpportunityRow>;
    },
    [activeViewParam, activeColumns],
  );

  // Wrapped fetchPage that tracks loaded IDs + syncs selection counters
  // so the bulk-action toolbar shows accurate counts. Forwards the
  // AbortSignal so a stale in-flight request cancelled by TanStack
  // Query (filter / view change) does NOT write into setLoadedIds.
  const fetchPageInstrumented = useCallback(
    async (cursor: string | null, f: OpportunityFilters, signal?: AbortSignal) => {
      const page = await fetchPage(cursor, f, signal);
      if (cursor === null) {
        const ids = page.data.map((row) => row.id);
        setLoadedIds(ids);
        dispatch({
          type: "sync_load_state",
          loadedCount: ids.length,
          total: page.total,
        });
      } else {
        setLoadedIds((prev) => {
          const next = [...prev, ...page.data.map((row) => row.id)];
          dispatch({
            type: "sync_load_state",
            loadedCount: next.length,
            total: page.total,
          });
          return next;
        });
      }
      return page;
    },
    [fetchPage, dispatch],
  );

  const renderRow = useCallback(
    (opportunity: OpportunityRow) => (
      <OpportunityDesktopRow
        opportunity={opportunity}
        columns={activeColumns}
        timePrefs={timePrefs}
        canDelete={user.isAdmin || opportunity.ownerId === user.id}
      />
    ),
    [activeColumns, timePrefs, user.id, user.isAdmin],
  );

  const renderCard = useCallback(
    (opportunity: OpportunityRow) => (
      <OpportunityListMobile
        rows={[
          {
            id: opportunity.id,
            name: opportunity.name,
            stage: opportunity.stage,
            amount: opportunity.amount ?? null,
            accountName: opportunity.accountName ?? null,
            expectedCloseDate: opportunity.expectedCloseDate ?? null,
          },
        ]}
      />
    ),
    [],
  );

  const applyDraft = () => {
    setFilters(draft);
    // BulkSelectionProvider's contract: clear selection on filter
    // change so an `all_loaded` / `all_matching` scope from the
    // previous result set doesn't leak into the next.
    dispatch({ type: "clear" });
  };
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    dispatch({ type: "clear" });
  };

  const filtersAreModified = Boolean(
    filters.q ||
      filters.owner ||
      filters.account ||
      filters.stage ||
      filters.closingWithinDays ||
      filters.minAmount ||
      filters.maxAmount ||
      filters.tag,
  );

  // MODIFIED badge detection — client-derived from columns + filters.
  // Sort drift is not tracked client-side today (no sort interaction
  // surface in the migrated list); columns and per-filter overlays
  // are the live signals.
  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);
  const viewModified = columnsModified || filtersAreModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (filters.q) modifiedFields.push("search");
  if (
    filters.owner ||
    filters.account ||
    filters.stage ||
    filters.closingWithinDays ||
    filters.minAmount ||
    filters.maxAmount ||
    filters.tag
  ) {
    modifiedFields.push("filters");
  }

  const filtersSlot = (
    <div className="space-y-3">
      {/* View selector + MODIFIED badge stay visible on every viewport
          so mobile users can switch views and reset modifications. The
          Columns chooser, Save-changes, Save-as-new, Subscribe, and
          Delete-view affordances are power-user controls hidden below
          md inside OpportunityViewToolbar itself. */}
      <OpportunityViewToolbar
        views={views}
        activeViewId={activeViewParam}
        activeViewName={activeViewName}
        activeColumns={activeColumns}
        baseColumns={baseColumns}
        savedDirtyId={savedDirtyId}
        columnsModified={columnsModified}
        viewModified={viewModified}
        modifiedFields={modifiedFields}
        subscribedViewIds={subscribedViewIds}
        defaultViewId={defaultViewId}
        resetClientState={clearFilters}
      />

      {/* Selection bar (renders when ≥1 row checked). Desktop only —
          BulkArchive uses per-row RowCheckbox which is desktop-table
          specific. */}
      <div className="hidden md:block">
        <BulkArchiveBar />
      </div>

      <OpportunityFiltersBar
        draft={draft}
        onDraftChange={setDraft}
        onApply={applyDraft}
        onClear={clearFilters}
        onMobileImmediate={(next) => {
          setDraft(next);
          setFilters(next);
          dispatch({ type: "clear" });
        }}
        allTags={allTags}
        ownerOptions={ownerOptions}
        accountOptions={accountOptions}
        hasActiveFilters={filtersAreModified}
      />
    </div>
  );

  // Desktop column headers — DnD-enabled. The shell renders this slot
  // as the first child of the row list's horizontal-scroll wrapper, so
  // headers stay aligned with row cells when the table is wider than
  // the viewport. min-width matches the row's min-width: leading
  // RowCheckbox (40) + columns (140 each) + trailing actions (40) = 80
  // fixed cells plus 140 per column.
  const columnHeaderSlot = (
    <table
      className="data-table w-full divide-y divide-border/60 text-sm"
      style={{ minWidth: `${activeColumns.length * 140 + 80}px` }}
    >
      <SortableOpportunitiesHeaders
        initialColumns={activeColumns}
        activeViewId={activeViewParam}
      />
    </table>
  );

  const headerActions = (
    <>
      {user.isAdmin ? (
        <Link
          href="/opportunities/archived"
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted md:inline-flex"
        >
          Archived
        </Link>
      ) : null}
      <Link
        href="/opportunities/new"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        + New opportunity
      </Link>
    </>
  );

  // Table↔Pipeline toggle preserved from prior page header. Table
  // pill stays inert/active here; Pipeline links to the kanban view.
  const headerControls = (
    <div className="hidden gap-1 rounded-lg border border-glass-border bg-glass-1 p-1 md:flex">
      <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
        Table
      </span>
      <Link
        href="/opportunities/pipeline"
        className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Pipeline
      </Link>
    </div>
  );

  return (
    <StandardListPage<OpportunityRow, OpportunityFilters>
      entityType="opportunity"
      queryKey={["opportunities", activeViewParam, activeColumns.join(",")]}
      fetchPage={fetchPageInstrumented}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={48}
      cardEstimateSize={72}
      emptyState={
        <StandardEmptyState
          title="No opportunities match this view."
          description={
            filtersAreModified
              ? "Adjust or clear the filters to see records here."
              : undefined
          }
        />
      }
      header={{
        title: "Opportunities",
        controls: headerControls,
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
      columnHeaderSlot={columnHeaderSlot}
      bulkActions={{
        banner: <BulkSelectionBanner />,
        toolbar: (
          <BulkActionToolbar>
            <BulkTagToolbarButton
              loadedIds={loadedIds}
              availableTags={allTags}
              canApply={canApplyTags}
              filters={filters}
              activeViewParam={activeViewParam}
            />
          </BulkActionToolbar>
        ),
      }}
    />
  );
}

/**
 * Toolbar surface for the bulk-tag affordance. Reads the current
 * selection scope from BulkSelectionProvider and translates it into
 * the BulkScope shape that `bulkTagAction` accepts.
 */
function BulkTagToolbarButton({
  loadedIds,
  availableTags,
  canApply,
  filters,
  activeViewParam,
}: {
  loadedIds: string[];
  availableTags: AvailableTag[];
  canApply: boolean;
  filters: OpportunityFilters;
  activeViewParam: string;
}) {
  const { scope } = useBulkSelection();

  const bulkScope = useMemo(() => {
    if (scope.kind === "none") {
      return { kind: "ids" as const, ids: [] };
    }
    if (scope.kind === "individual") {
      return { kind: "ids" as const, ids: Array.from(scope.ids) };
    }
    if (scope.kind === "all_loaded") {
      return { kind: "ids" as const, ids: loadedIds };
    }
    // all_matching
    return {
      kind: "filtered" as const,
      entity: "opportunity" as const,
      filters: { ...filters, view: activeViewParam },
    };
  }, [scope, loadedIds, filters, activeViewParam]);

  return (
    <BulkTagButton
      entityType="opportunity"
      scope={bulkScope}
      availableTags={availableTags}
      canApply={canApply}
    />
  );
}

/**
 * Desktop row. Flex layout matching the column-header layout above —
 * each column is a flex-1 cell so widths align with the header row
 * driven by SortableOpportunitiesHeaders. Leading selection-checkbox
 * cell + trailing actions cell stay fixed-width.
 */
function OpportunityDesktopRow({
  opportunity,
  columns,
  timePrefs,
  canDelete,
}: {
  opportunity: OpportunityRow;
  columns: OpportunityColumnKey[];
  timePrefs: TimePrefs;
  canDelete: boolean;
}) {
  // Match the column-header tier's min-width so the row stays aligned
  // with header cells when the table is wider than the viewport.
  // Leading RowCheckbox (w-10) + trailing actions (w-10) = 80 fixed.
  const minRowWidth = columns.length * 140 + 80;
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
      style={{ minWidth: `${minRowWidth}px` }}
    >
      <div className="w-10 shrink-0 px-2 py-3">
        <RowCheckbox id={opportunity.id} version={opportunity.version} />
      </div>
      {columns.map((c) => {
        const colLabel =
          AVAILABLE_OPPORTUNITY_COLUMNS.find((col) => col.key === c)?.label ??
          c;
        return (
          <div
            key={c}
            data-label={colLabel}
            className="min-w-0 flex-1 truncate px-5 py-3"
            style={{ flexBasis: "140px" }}
          >
            {renderCell(opportunity, c, timePrefs)}
          </div>
        );
      })}
      <div className="w-10 shrink-0 px-2 py-3">
        <OpportunityRowActions
          opportunityId={opportunity.id}
          opportunityName={opportunity.name}
          canDelete={canDelete}
        />
      </div>
    </div>
  );
}

function OpportunityFiltersBar({
  draft,
  onDraftChange,
  onApply,
  onClear,
  onMobileImmediate,
  allTags,
  ownerOptions,
  accountOptions,
  hasActiveFilters,
}: {
  draft: OpportunityFilters;
  onDraftChange: (next: OpportunityFilters) => void;
  onApply: () => void;
  onClear: () => void;
  onMobileImmediate: (next: OpportunityFilters) => void;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  accountOptions: AccountOption[];
  hasActiveFilters: boolean;
}) {
  const setField = <K extends keyof OpportunityFilters>(
    key: K,
    value: OpportunityFilters[K],
  ) => onDraftChange({ ...draft, [key]: value });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
      className="sticky top-0 z-30 -mx-4 space-y-2 border-b border-border/40 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6 md:static md:z-auto md:mx-0 md:space-y-0 md:border-0 md:bg-transparent md:px-0 md:pt-0 md:pb-0 md:backdrop-blur-none"
    >
      {/* ROW 1 — search on mobile. */}
      <div className="md:hidden">
        <label className="relative block">
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx={9} cy={9} r={6} />
            <path d="m17 17-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={draft.q}
            onChange={(e) => setField("q", e.target.value)}
            onBlur={onApply}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApply();
              }
            }}
            placeholder="Search name or description…"
            className="block h-11 w-full rounded-full border border-border bg-muted/40 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </div>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0 md:[mask-image:none]">
        {/* Desktop search input. */}
        <input
          type="search"
          value={draft.q}
          onChange={(e) => setField("q", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onApply();
            }
          }}
          placeholder="Search name or description…"
          className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
        />

        {/* Mobile chip-style selects (auto-apply). */}
        <div className="contents md:hidden">
          <ControlledMobileSelect
            value={draft.stage}
            onChange={(v) => onMobileImmediate({ ...draft, stage: v })}
            options={STAGE_OPTIONS}
            placeholder="Stage"
          />
          {accountOptions.length > 0 ? (
            <ControlledMobileSelect
              value={draft.account}
              onChange={(v) => onMobileImmediate({ ...draft, account: v })}
              options={accountOptions}
              placeholder="Account"
            />
          ) : null}
          {ownerOptions.length > 0 ? (
            <ControlledMobileSelect
              value={draft.owner}
              onChange={(v) => onMobileImmediate({ ...draft, owner: v })}
              options={ownerOptions}
              placeholder="Owner"
            />
          ) : null}
          <ControlledMobileSelect
            value={draft.closingWithinDays}
            onChange={(v) =>
              onMobileImmediate({ ...draft, closingWithinDays: v })
            }
            options={CLOSING_WITHIN_OPTIONS}
            placeholder="Closing"
          />
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClear}
              className="h-11 shrink-0 rounded-full px-4 text-sm text-muted-foreground hover:text-foreground/90"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Desktop selects + numeric range + Apply. */}
        <div className="hidden items-center gap-2 md:flex md:gap-3">
          <ControlledFilterSelect
            value={draft.stage}
            onChange={(v) => setField("stage", v)}
            options={STAGE_OPTIONS}
            placeholder="Stage"
          />
          {accountOptions.length > 0 ? (
            <ControlledFilterSelect
              value={draft.account}
              onChange={(v) => setField("account", v)}
              options={accountOptions}
              placeholder="Account"
            />
          ) : null}
          {ownerOptions.length > 0 ? (
            <ControlledFilterSelect
              value={draft.owner}
              onChange={(v) => setField("owner", v)}
              options={ownerOptions}
              placeholder="Owner"
            />
          ) : null}
          <ControlledFilterSelect
            value={draft.closingWithinDays}
            onChange={(v) => setField("closingWithinDays", v)}
            options={CLOSING_WITHIN_OPTIONS}
            placeholder="Closing"
          />
          {/* First numeric range filter pair in the codebase. Inline
              per Rule of 3 — no second occurrence yet to justify an
              abstraction. Empty string treated as "no filter"; the
              API route validates with parseFloat + isFinite. */}
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={100}
            value={draft.minAmount}
            onChange={(e) => setField("minAmount", e.target.value)}
            placeholder="Min $"
            className="w-24 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={100}
            value={draft.maxAmount}
            onChange={(e) => setField("maxAmount", e.target.value)}
            placeholder="Max $"
            className="w-24 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <ControlledTagFilter
            value={draft.tag}
            options={allTags}
            onChange={(v) => setField("tag", v)}
          />
          <button
            type="submit"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Apply
          </button>
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground/90"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function ControlledFilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ControlledMobileSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  const isSet = value.length > 0;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-11 min-w-0 shrink-0 appearance-none rounded-full border px-4 pr-8 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-ring/40",
        isSet
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor'><path d='M5.516 7.548c.436-.446 1.043-.481 1.527 0L10 10.5l2.957-2.952c.483-.481 1.091-.446 1.527 0 .437.445.418 1.196 0 1.625-.418.43-4.5 4.5-4.5 4.5a1.063 1.063 0 0 1-1.498 0s-4.083-4.07-4.5-4.5c-.418-.43-.436-1.18 0-1.625Z'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.5rem center",
        backgroundSize: "1rem",
      }}
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Controlled multi-tag filter. Functionally equivalent to the existing
 * TagFilterSelect (which renders a hidden URL-form input and manages
 * its own state). Local-only because TagFilterSelect's uncontrolled
 * design doesn't expose an onChange callback — and the Rule of 3
 * doesn't yet justify extracting a controlled variant.
 */
function ControlledTagFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: AvailableTag[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(containerRef, () => setOpen(false), open);

  const selected = useMemo(
    () =>
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [value],
  );

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((n) => n !== name)
      : [...selected, name];
    onChange(next.join(","));
  };

  const clearAll = () => onChange("");

  const buttonLabel =
    selected.length === 0
      ? "All Tags"
      : selected.length === 1
        ? selected[0]
        : `Tags: ${selected.length}`;

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm transition hover:bg-muted",
          selected.length > 0 ? "text-foreground" : "text-foreground/80",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="inline-flex items-center gap-1 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{buttonLabel}</span>
        </button>
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clearAll();
            }}
            aria-label="Clear tag filter"
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-xl"
        >
          {options.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No tags yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {options.map((t) => {
                const isPicked = selected.includes(t.name);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t.name)}
                    aria-pressed={isPicked}
                    className={cn(
                      "rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isPicked
                        ? "opacity-100 ring-2 ring-ring"
                        : "opacity-60 hover:opacity-90",
                    )}
                  >
                    <TagChip name={t.name} color={t.color ?? "slate"} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatAmount(a: string | null): string {
  if (a === null || a === undefined || a === "") return "—";
  const n = Number(a);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatExpectedCloseDate(d: string | null): React.ReactNode {
  if (!d) return <span className="text-muted-foreground/80">—</span>;
  // d is a yyyy-mm-dd string from the date column; render as MM/DD/YYYY.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return <span className="text-muted-foreground">{d}</span>;
  return (
    <span className="text-muted-foreground tabular-nums">
      {m[2]}/{m[3]}/{m[1]}
    </span>
  );
}

function renderCell(
  row: OpportunityRow,
  col: OpportunityColumnKey,
  prefs: TimePrefs,
) {
  switch (col) {
    case "name":
      return (
        <Link
          href={`/opportunities/${row.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.name}
        </Link>
      );
    case "stage":
      return <StatusPill status={row.stage} />;
    case "account":
      return row.accountId ? (
        <Link
          href={`/accounts/${row.accountId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.accountName ?? "—"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "primaryContact":
      return row.primaryContactId ? (
        <Link
          href={`/contacts/${row.primaryContactId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.primaryContactName ?? "—"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "amount":
      return (
        <span className="tabular-nums text-foreground/80">
          {formatAmount(row.amount)}
        </span>
      );
    case "probability":
      return (
        <span className="tabular-nums text-muted-foreground">
          {typeof row.probability === "number" ? `${row.probability}%` : "—"}
        </span>
      );
    case "expectedCloseDate":
      return formatExpectedCloseDate(row.expectedCloseDate);
    case "owner":
      return row.ownerId ? (
        <UserChip
          user={{
            id: row.ownerId,
            displayName: row.ownerDisplayName,
            photoUrl: row.ownerPhotoUrl,
          }}
        />
      ) : (
        <span className="text-muted-foreground">Unassigned</span>
      );
    case "closedAt":
      return row.closedAt ? (
        <span className="text-muted-foreground">
          <UserTimeClient value={row.closedAt} prefs={prefs} mode="date" />
        </span>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "tags":
      return <TagsCell tags={row.tags} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          <UserTimeClient value={row.createdAt} prefs={prefs} mode="date" />
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          <UserTimeClient value={row.updatedAt} prefs={prefs} />
        </span>
      );
    default:
      return null;
  }
}
