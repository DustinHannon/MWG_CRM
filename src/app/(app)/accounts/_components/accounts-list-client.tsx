"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
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
import { cn } from "@/lib/utils";
import { type TimePrefs } from "@/lib/format-time";
import {
  AVAILABLE_ACCOUNT_COLUMNS,
  type AccountColumnKey,
} from "@/lib/account-view-constants";
import type { AccountRow } from "@/lib/account-views";
import { AccountListMobile } from "./account-list-mobile";
import { AccountRowActions } from "./account-row-actions";
import {
  BulkArchiveBar,
  BulkArchiveProvider,
  RowCheckbox,
} from "./bulk-archive";
import { SortableAccountsHeaders } from "./sortable-headers";
import {
  AccountViewToolbar,
  type AccountViewSummary,
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

interface IndustryOption {
  value: string;
  label: string;
}

interface ActorLite {
  id: string;
  isAdmin: boolean;
}

export interface AccountsListClientProps {
  user: ActorLite;
  timePrefs: TimePrefs;
  activeViewParam: string;
  activeViewName: string;
  activeColumns: AccountColumnKey[];
  baseColumns: AccountColumnKey[];
  views: AccountViewSummary[];
  savedDirtyId: string | null;
  subscribedViewIds: string[];
  defaultViewId: string | null;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  industryOptions: IndustryOption[];
  canApplyTags: boolean;
}

interface AccountFilters {
  q: string;
  owner: string;
  industry: string;
  recentlyUpdatedDays: string;
  tag: string; // comma-separated tag names
}

const EMPTY_FILTERS: AccountFilters = {
  q: "",
  owner: "",
  industry: "",
  recentlyUpdatedDays: "",
  tag: "",
};

const RECENTLY_UPDATED_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "7", label: "Past 7 days" },
  { value: "30", label: "Past 30 days" },
  { value: "90", label: "Past 90 days" },
];

/**
 * Client-side accounts list. Owns:
 *   - Filter state (q / owner / industry / recentlyUpdatedDays / tag).
 *   - TanStack Query cache (via StandardListPage's infinite scroll).
 *   - Bulk selection state for bulk-tag via BulkSelectionProvider.
 *   - Bulk archive selection state via BulkArchiveProvider (legacy
 *     per-row checkbox-driven flow — separate surface, separate state).
 *
 * Saved-view + columns + view selection remain server-driven. The
 * server-rendered shell passes `activeViewParam` and `activeColumns`
 * as props; whenever the view changes via URL (the AccountViewToolbar
 * pushes `/accounts?view=...`), Next.js re-renders the server shell
 * which passes new props in. The outer `key={activeViewParam}` forces
 * a remount on view change so filter state resets.
 */
export function AccountsListClient(props: AccountsListClientProps) {
  return (
    <BulkArchiveProvider>
      <BulkSelectionProvider>
        <AccountsListInner {...props} />
      </BulkSelectionProvider>
    </BulkArchiveProvider>
  );
}

function AccountsListInner({
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
  industryOptions,
  canApplyTags,
}: AccountsListClientProps) {
  const [filters, setFilters] = useState<AccountFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<AccountFilters>(EMPTY_FILTERS);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const { dispatch } = useBulkSelection();

  const memoizedFilters = useMemo<AccountFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: AccountFilters,
    ): Promise<StandardListPagePage<AccountRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("view", activeViewParam);
      params.set("cols", activeColumns.join(","));
      if (f.q) params.set("q", f.q);
      if (f.owner) params.set("owner", f.owner);
      if (f.industry) params.set("industry", f.industry);
      if (f.recentlyUpdatedDays)
        params.set("recentlyUpdatedDays", f.recentlyUpdatedDays);
      if (f.tag) params.set("tag", f.tag);
      const res = await fetch(`/api/accounts/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load accounts (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<AccountRow>;
    },
    [activeViewParam, activeColumns],
  );

  // Wrapped fetchPage that tracks loaded IDs + syncs selection counters
  // so the bulk-action toolbar shows accurate counts.
  const fetchPageInstrumented = useCallback(
    async (cursor: string | null, f: AccountFilters) => {
      const page = await fetchPage(cursor, f);
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
    (account: AccountRow) => (
      <AccountDesktopRow
        account={account}
        columns={activeColumns}
        timePrefs={timePrefs}
        canDelete={user.isAdmin || account.ownerId === user.id}
      />
    ),
    [activeColumns, timePrefs, user.id, user.isAdmin],
  );

  const renderCard = useCallback(
    (account: AccountRow) => (
      <AccountListMobile
        rows={[
          {
            id: account.id,
            name: account.name,
            industry: account.industry ?? null,
            wonDeals: account.wonDeals,
            createdAt: account.createdAt,
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

  const hasActiveFilters = Boolean(
    filters.q ||
      filters.owner ||
      filters.industry ||
      filters.recentlyUpdatedDays ||
      filters.tag,
  );

  // MODIFIED badge detection — client-derived from columns + filters.
  // Sort drift is not tracked client-side today (no sort interaction
  // surface in the migrated list); columns and per-filter overlays
  // are the live signals.
  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);
  const filtersAreModified = Boolean(
    filters.q ||
      filters.owner ||
      filters.industry ||
      filters.recentlyUpdatedDays ||
      filters.tag,
  );
  const viewModified = columnsModified || filtersAreModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (filters.q) modifiedFields.push("search");
  if (
    filters.owner ||
    filters.industry ||
    filters.recentlyUpdatedDays ||
    filters.tag
  ) {
    modifiedFields.push("filters");
  }

  const filtersSlot = (
    <div className="space-y-3">
      {/* View selector + MODIFIED badge + Save-as-new + Columns
          chooser. Desktop-only — these are power-user affordances
          that don't fit the mobile chip toolbar. Lives inside the
          client component so the MODIFIED badge can react to client
          filter state. */}
      <div className="hidden md:block">
        <AccountViewToolbar
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
      </div>

      {/* Selection bar (renders when ≥1 row checked). Desktop only —
          BulkArchive uses per-row RowCheckbox which is desktop-table
          specific. */}
      <div className="hidden md:block">
        <BulkArchiveBar />
      </div>

      <AccountFiltersBar
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
        industryOptions={industryOptions}
        hasActiveFilters={hasActiveFilters}
      />

      {/* Desktop column headers — DnD-enabled. Renders as a `<thead>`
          inside a `<table>` wrapper so the existing component (which
          expects to live in a table) keeps the same DOM contract.
          Includes a leading selection-checkbox column to align with
          the RowCheckbox cell in each row. */}
      <div className="hidden overflow-x-auto rounded-t-lg border border-b-0 border-border bg-muted/40 md:block">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <SortableAccountsHeaders
            initialColumns={activeColumns}
            activeViewId={activeViewParam}
          />
        </table>
      </div>
    </div>
  );

  const headerActions = (
    <>
      {user.isAdmin ? (
        <Link
          href="/accounts/archived"
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Archived
        </Link>
      ) : null}
      <Link
        href="/accounts/new"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        + Add account
      </Link>
    </>
  );

  return (
    <StandardListPage<AccountRow, AccountFilters>
      queryKey={["accounts", activeViewParam, activeColumns.join(",")]}
      fetchPage={fetchPageInstrumented}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={88}
      emptyState={
        <StandardEmptyState
          title="No accounts match this view."
          description={
            hasActiveFilters
              ? "Adjust or clear the filters to see records here."
              : undefined
          }
        />
      }
      header={{
        kicker: "Accounts",
        title: "Accounts",
        fontFamily: "display",
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
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
  filters: AccountFilters;
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
      entity: "account" as const,
      filters: { ...filters, view: activeViewParam },
    };
  }, [scope, loadedIds, filters, activeViewParam]);

  return (
    <BulkTagButton
      entityType="account"
      scope={bulkScope}
      availableTags={availableTags}
      canApply={canApply}
    />
  );
}

/**
 * Desktop row. Flex layout matching the column-header layout above —
 * each column is a flex-1 cell so widths align with the header row
 * driven by SortableAccountsHeaders. Leading selection-checkbox cell
 * + trailing actions cell stay fixed-width.
 */
function AccountDesktopRow({
  account,
  columns,
  timePrefs,
  canDelete,
}: {
  account: AccountRow;
  columns: AccountColumnKey[];
  timePrefs: TimePrefs;
  canDelete: boolean;
}) {
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
    >
      <div className="w-10 shrink-0 px-2 py-3">
        <RowCheckbox id={account.id} />
      </div>
      {columns.map((c) => {
        const colLabel =
          AVAILABLE_ACCOUNT_COLUMNS.find((col) => col.key === c)?.label ?? c;
        return (
          <div
            key={c}
            data-label={colLabel}
            className="min-w-0 flex-1 truncate px-5 py-3"
          >
            {renderCell(account, c, timePrefs)}
          </div>
        );
      })}
      <div className="w-10 shrink-0 px-2 py-3">
        <AccountRowActions
          accountId={account.id}
          accountName={account.name}
          canDelete={canDelete}
        />
      </div>
    </div>
  );
}

function AccountFiltersBar({
  draft,
  onDraftChange,
  onApply,
  onClear,
  onMobileImmediate,
  allTags,
  ownerOptions,
  industryOptions,
  hasActiveFilters,
}: {
  draft: AccountFilters;
  onDraftChange: (next: AccountFilters) => void;
  onApply: () => void;
  onClear: () => void;
  onMobileImmediate: (next: AccountFilters) => void;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  industryOptions: IndustryOption[];
  hasActiveFilters: boolean;
}) {
  const setField = (key: keyof AccountFilters, value: string) =>
    onDraftChange({ ...draft, [key]: value });

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
            placeholder="Search name, website, industry…"
            className="block h-11 w-full rounded-full border border-border bg-muted/40 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </div>

      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0">
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
          placeholder="Search name / website / industry…"
          className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
        />

        {/* Mobile chip-style selects (auto-apply). */}
        <div className="contents md:hidden">
          {industryOptions.length > 0 ? (
            <ControlledMobileSelect
              value={draft.industry}
              onChange={(v) =>
                onMobileImmediate({ ...draft, industry: v })
              }
              options={industryOptions}
              placeholder="Industry"
            />
          ) : null}
          {ownerOptions.length > 0 ? (
            <ControlledMobileSelect
              value={draft.owner}
              onChange={(v) =>
                onMobileImmediate({ ...draft, owner: v })
              }
              options={ownerOptions}
              placeholder="Owner"
            />
          ) : null}
          <ControlledMobileSelect
            value={draft.recentlyUpdatedDays}
            onChange={(v) =>
              onMobileImmediate({ ...draft, recentlyUpdatedDays: v })
            }
            options={RECENTLY_UPDATED_OPTIONS}
            placeholder="Updated"
          />
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onClear}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/90"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Desktop selects + Apply. */}
        <div className="hidden items-center gap-2 md:flex md:gap-3">
          {industryOptions.length > 0 ? (
            <ControlledFilterSelect
              value={draft.industry}
              onChange={(v) => setField("industry", v)}
              options={industryOptions}
              placeholder="Industry"
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
            value={draft.recentlyUpdatedDays}
            onChange={(v) => setField("recentlyUpdatedDays", v)}
            options={RECENTLY_UPDATED_OPTIONS}
            placeholder="Updated"
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
        "h-9 min-w-0 shrink-0 appearance-none rounded-full border px-3 pr-7 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-ring/40",
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

  const selected = useMemo(
    () =>
      value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [value],
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

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

function renderCell(
  row: AccountRow,
  col: AccountColumnKey,
  prefs: TimePrefs,
) {
  switch (col) {
    case "name":
      return (
        <Link
          href={`/accounts/${row.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.name}
        </Link>
      );
    case "industry":
      return (
        <span className="text-muted-foreground">{row.industry ?? "—"}</span>
      );
    case "website":
      return row.website ? (
        <a
          href={
            row.website.startsWith("http")
              ? row.website
              : `https://${row.website}`
          }
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.website.replace(/^https?:\/\//, "")}
        </a>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "city":
      return <span className="text-muted-foreground">{row.city ?? "—"}</span>;
    case "state":
      return <span className="text-muted-foreground">{row.state ?? "—"}</span>;
    case "country":
      return (
        <span className="text-muted-foreground">{row.country ?? "—"}</span>
      );
    case "phone":
      return <span className="text-muted-foreground">{row.phone ?? "—"}</span>;
    case "email":
      return row.email ? (
        <a
          href={`mailto:${row.email}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.email}
        </a>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "accountNumber":
      return (
        <span className="font-mono text-xs text-muted-foreground">
          {row.accountNumber ?? "—"}
        </span>
      );
    case "numberOfEmployees":
      return (
        <span className="tabular-nums text-muted-foreground">
          {row.numberOfEmployees != null
            ? row.numberOfEmployees.toLocaleString()
            : "—"}
        </span>
      );
    case "annualRevenue":
      return (
        <span className="tabular-nums text-muted-foreground">
          {row.annualRevenue != null
            ? `$${Number(row.annualRevenue).toLocaleString()}`
            : "—"}
        </span>
      );
    case "primaryContact":
      return row.primaryContactId ? (
        <Link
          href={`/contacts/${row.primaryContactId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.primaryContactName ?? "(unnamed)"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "parentAccount":
      return row.parentAccountId ? (
        <Link
          href={`/accounts/${row.parentAccountId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.parentAccountName ?? "(unnamed)"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
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
    case "wonDeals":
      return (
        <span className="tabular-nums text-foreground/80">
          {row.wonDeals > 0 ? row.wonDeals : "—"}
        </span>
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
