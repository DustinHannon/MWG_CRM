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
import { StatusPill } from "@/components/ui/status-pill";
import { PriorityPill } from "@/components/ui/priority-pill";
import { UserChip } from "@/components/user-display/user-chip";
import { cn } from "@/lib/utils";
import { formatUserTime, type TimePrefs } from "@/lib/format-time";
import {
  AVAILABLE_COLUMNS,
  type ColumnKey,
} from "@/lib/view-constants";
import type { LeadRow } from "@/lib/views";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import { AddVisibleToListButton } from "./add-visible-to-list-button";
import { LeadListMobile } from "./lead-list-mobile";
import { LeadRowActions } from "./lead-row-actions";
import { SortableLeadsHeaders } from "./sortable-leads-headers";
import { ViewToolbar, type ViewSummary } from "../view-toolbar";

interface AvailableTag {
  id: string;
  name: string;
  color: string | null;
}

interface ActorLite {
  id: string;
  isAdmin: boolean;
}

export interface LeadsListClientProps {
  user: ActorLite;
  timePrefs: TimePrefs;
  activeViewParam: string;
  activeViewName: string;
  activeColumns: ColumnKey[];
  baseColumns: ColumnKey[];
  views: ViewSummary[];
  savedDirtyId: string | null;
  subscribedViewIds: string[];
  allTags: AvailableTag[];
  canApplyTags: boolean;
  canMarketingListsBulkAdd: boolean;
  canImport: boolean;
  canExport: boolean;
  canCreateLeads: boolean;
}

interface LeadFilters {
  q: string;
  status: string;
  rating: string;
  source: string;
  tag: string; // comma-separated tag names
}

const EMPTY_FILTERS: LeadFilters = {
  q: "",
  status: "",
  rating: "",
  source: "",
  tag: "",
};

/**
 * Client-side leads list. Owns:
 *   - Filter state (q / status / rating / source / tag) — replaces the
 *     previous URL-param-driven filter form.
 *   - TanStack Query cache (via StandardListPage's infinite scroll).
 *   - Bulk selection state via BulkSelectionProvider.
 *
 * Saved-view + columns + view selection remain server-driven. The
 * server-rendered shell passes `activeViewParam` and `activeColumns`
 * as props; whenever the view changes via URL (the ViewToolbar pushes
 * `/leads?view=...`), Next.js re-renders the server shell which
 * passes new props in. This component effects on `activeViewParam`
 * to reset filter overlay when the view changes.
 */
export function LeadsListClient(props: LeadsListClientProps) {
  return (
    <BulkSelectionProvider>
      <LeadsListInner {...props} />
    </BulkSelectionProvider>
  );
}

function LeadsListInner({
  user,
  timePrefs,
  activeViewParam,
  activeViewName,
  activeColumns,
  baseColumns,
  views,
  savedDirtyId,
  subscribedViewIds,
  allTags,
  canApplyTags,
  canMarketingListsBulkAdd,
  canImport,
  canExport,
  canCreateLeads,
}: LeadsListClientProps) {
  const [filters, setFilters] = useState<LeadFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<LeadFilters>(EMPTY_FILTERS);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const { dispatch } = useBulkSelection();

  // View / column changes reset this component naturally via the
  // outer `key` prop the server page passes to `<LeadsListClient>`.
  // No effect needed — re-mounting initializes filters to EMPTY_FILTERS.

  const memoizedFilters = useMemo<LeadFilters>(
    () => filters,
    [filters],
  );

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: LeadFilters,
    ): Promise<StandardListPagePage<LeadRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("view", activeViewParam);
      params.set("cols", activeColumns.join(","));
      if (f.q) params.set("q", f.q);
      if (f.status) params.set("status", f.status);
      if (f.rating) params.set("rating", f.rating);
      if (f.source) params.set("source", f.source);
      if (f.tag) params.set("tag", f.tag);
      const res = await fetch(`/api/leads/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load leads (${res.status})`);
      }
      const body = (await res.json()) as StandardListPagePage<LeadRow>;
      return body;
    },
    [activeViewParam, activeColumns],
  );

  // Wrapped fetchPage that tracks loaded IDs + syncs selection counters
  // so the bulk-action toolbar shows accurate counts.
  const fetchPageInstrumented = useCallback(
    async (cursor: string | null, f: LeadFilters) => {
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
    (lead: LeadRow) => (
      <LeadDesktopRow
        lead={lead}
        columns={activeColumns}
        timePrefs={timePrefs}
        canDelete={user.isAdmin || lead.ownerId === user.id}
      />
    ),
    [activeColumns, timePrefs, user.id, user.isAdmin],
  );

  const renderCard = useCallback(
    (lead: LeadRow) => <LeadListMobile rows={[lead]} />,
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
      filters.status ||
      filters.rating ||
      filters.source ||
      filters.tag,
  );

  // MODIFIED badge detection — covers column drift AND any client
  // filter divergence from the saved view's empty-filter baseline.
  // Sort drift is not tracked client-side today (no sort interaction
  // surface in the migrated list); columns and per-filter overlays
  // are the live signals.
  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);
  const filtersAreModified = Boolean(
    filters.q ||
      filters.status ||
      filters.rating ||
      filters.source ||
      filters.tag,
  );
  const viewModified = columnsModified || filtersAreModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (filters.q) modifiedFields.push("search");
  if (filters.status || filters.rating || filters.source || filters.tag) {
    modifiedFields.push("filters");
  }

  const exportHref = buildExportHref(activeViewParam, activeColumns, filters);

  const filtersSlot = (
    <div className="space-y-3">
      {/* View selector + MODIFIED badge + Save-as-new + Columns
          chooser. Desktop-only — these are power-user affordances
          that don't fit the mobile chip toolbar. Lives inside the
          client component so the MODIFIED badge can react to client
          filter state (search / status / rating / source / tag). */}
      <div className="hidden md:block">
        <ViewToolbar
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
          resetClientState={clearFilters}
        />
      </div>

      <LeadFiltersBar
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
        hasActiveFilters={hasActiveFilters}
      />

      {/* Desktop column headers — DnD-enabled. Renders as a `<thead>`
          inside a `<table>` wrapper so the existing component (which
          expects to live in a table) keeps the same DOM contract.
          The desktop row container uses a matching column layout via
          shared column keys. */}
      <div className="hidden overflow-x-auto rounded-t-lg border border-b-0 border-border bg-muted/40 md:block">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <SortableLeadsHeaders
            initialColumns={activeColumns}
            activeViewId={activeViewParam}
          />
        </table>
      </div>
    </div>
  );

  const headerActions = (
    <>
      {canImport ? (
        <Link
          href="/leads/import"
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Import
        </Link>
      ) : null}
      {canExport ? (
        <a
          href={exportHref}
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Export
        </a>
      ) : null}
      <div className="hidden md:inline-flex">
        <AddVisibleToListButton
          leadIds={loadedIds}
          canManage={canMarketingListsBulkAdd}
        />
      </div>
      {canCreateLeads ? (
        <Link
          href="/leads/new"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          + Add lead
        </Link>
      ) : null}
    </>
  );

  const headerControls = (
    <div className="hidden gap-1 rounded-lg border border-glass-border bg-glass-1 p-1 md:flex">
      <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
        Table
      </span>
      <Link
        href="/leads/pipeline"
        className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Pipeline
      </Link>
    </div>
  );

  return (
    <StandardListPage<LeadRow, LeadFilters>
      queryKey={["leads", activeViewParam, activeColumns.join(",")]}
      fetchPage={fetchPageInstrumented}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={88}
      emptyState={
        <StandardEmptyState
          title="No leads match this view."
          description={
            hasActiveFilters
              ? "Adjust or clear the filters to see records here."
              : undefined
          }
        />
      }
      header={{
        title: "Leads",
        controls: headerControls,
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
  filters: LeadFilters;
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
      entity: "lead" as const,
      filters: { ...filters, view: activeViewParam },
    };
  }, [scope, loadedIds, filters, activeViewParam]);

  return (
    <BulkTagButton
      entityType="lead"
      scope={bulkScope}
      availableTags={availableTags}
      canApply={canApply}
    />
  );
}

/**
 * Desktop row. Flex layout matching the column-header layout above
 * — each column is a flex-1 cell so widths align with the header
 * row driven by SortableLeadsHeaders. Trailing actions cell stays
 * fixed-width.
 */
function LeadDesktopRow({
  lead,
  columns,
  timePrefs,
  canDelete,
}: {
  lead: LeadRow;
  columns: ColumnKey[];
  timePrefs: TimePrefs;
  canDelete: boolean;
}) {
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
    >
      {columns.map((c) => {
        const colLabel =
          AVAILABLE_COLUMNS.find((col) => col.key === c)?.label ?? c;
        return (
          <div
            key={c}
            data-label={colLabel}
            className="min-w-0 flex-1 truncate px-5 py-3"
          >
            {renderCell(lead, c, timePrefs)}
          </div>
        );
      })}
      <div className="w-10 shrink-0 px-2 py-3">
        <LeadRowActions
          leadId={lead.id}
          leadName={leadDisplayName(lead)}
          canDelete={canDelete}
        />
      </div>
    </div>
  );
}

function LeadFiltersBar({
  draft,
  onDraftChange,
  onApply,
  onClear,
  onMobileImmediate,
  allTags,
  hasActiveFilters,
}: {
  draft: LeadFilters;
  onDraftChange: (next: LeadFilters) => void;
  onApply: () => void;
  onClear: () => void;
  onMobileImmediate: (next: LeadFilters) => void;
  allTags: AvailableTag[];
  hasActiveFilters: boolean;
}) {
  const setField = (key: keyof LeadFilters, value: string) =>
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
            placeholder="Search name, email, company…"
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
          placeholder="Search name / email / company / phone…"
          className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
        />

        {/* Mobile chip-style selects (auto-apply). */}
        <div className="contents md:hidden">
          <ControlledMobileSelect
            value={draft.status}
            onChange={(v) =>
              onMobileImmediate({ ...draft, status: v })
            }
            options={LEAD_STATUSES}
            placeholder="Status"
          />
          <ControlledMobileSelect
            value={draft.rating}
            onChange={(v) =>
              onMobileImmediate({ ...draft, rating: v })
            }
            options={LEAD_RATINGS}
            placeholder="Rating"
          />
          <ControlledMobileSelect
            value={draft.source}
            onChange={(v) =>
              onMobileImmediate({ ...draft, source: v })
            }
            options={LEAD_SOURCES}
            placeholder="Source"
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
          <ControlledFilterSelect
            value={draft.status}
            onChange={(v) => setField("status", v)}
            options={LEAD_STATUSES}
            placeholder="Status"
          />
          <ControlledFilterSelect
            value={draft.rating}
            onChange={(v) => setField("rating", v)}
            options={LEAD_RATINGS}
            placeholder="Rating"
          />
          <ControlledFilterSelect
            value={draft.source}
            onChange={(v) => setField("source", v)}
            options={LEAD_SOURCES}
            placeholder="Source"
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
  options: readonly string[];
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
        <option key={o} value={o}>
          {o.replaceAll("_", " ")}
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
  options: readonly string[];
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
        <option key={o} value={o}>
          {o.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}

/**
 * Controlled multi-tag filter. Functionally equivalent to the
 * existing TagFilterSelect (which renders a hidden URL-form input
 * and manages its own state). Local-only because TagFilterSelect's
 * uncontrolled design doesn't expose an onChange callback — and the
 * Rule of 3 doesn't yet justify extracting a controlled variant.
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

function leadDisplayName(l: LeadRow): string {
  const name = `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim();
  return name || l.companyName || l.email || "this lead";
}

function buildExportHref(
  viewParam: string,
  cols: ColumnKey[],
  filters: LeadFilters,
): string {
  const params = new URLSearchParams();
  params.set("view", viewParam);
  if (cols.length > 0) params.set("cols", cols.join(","));
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.rating) params.set("rating", filters.rating);
  if (filters.source) params.set("source", filters.source);
  if (filters.tag) params.set("tag", filters.tag);
  return `/api/leads/export?${params.toString()}`;
}

function renderCell(lead: LeadRow, col: ColumnKey, prefs: TimePrefs) {
  switch (col) {
    case "firstName":
      return (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {lead.firstName}
        </Link>
      );
    case "lastName":
      return lead.lastName ? (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {lead.lastName}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "companyName":
      return (
        <span className="text-foreground/80">{lead.companyName ?? "—"}</span>
      );
    case "email":
      return <span className="text-muted-foreground">{lead.email ?? "—"}</span>;
    case "phone":
      return <span className="text-muted-foreground">{lead.phone ?? "—"}</span>;
    case "mobilePhone":
      return (
        <span className="text-muted-foreground">{lead.mobilePhone ?? "—"}</span>
      );
    case "jobTitle":
      return (
        <span className="text-muted-foreground">{lead.jobTitle ?? "—"}</span>
      );
    case "status":
      return <StatusPill status={lead.status} />;
    case "rating":
      return <PriorityPill priority={lead.rating} />;
    case "source":
      return <Pill kind="source" value={lead.source} />;
    case "owner":
      return lead.ownerId ? (
        <UserChip
          user={{
            id: lead.ownerId,
            displayName: lead.ownerDisplayName,
            photoUrl: lead.ownerPhotoUrl,
          }}
        />
      ) : (
        <span className="text-muted-foreground">Unassigned</span>
      );
    case "tags":
      return <TagsCell tags={lead.tags} />;
    case "city":
      return <span className="text-muted-foreground">{lead.city ?? "—"}</span>;
    case "state":
      return <span className="text-muted-foreground">{lead.state ?? "—"}</span>;
    case "estimatedValue":
      return (
        <span className="tabular-nums text-muted-foreground">
          {lead.estimatedValue
            ? `$${Number(lead.estimatedValue).toLocaleString()}`
            : "—"}
        </span>
      );
    case "estimatedCloseDate":
      return (
        <span className="text-muted-foreground">
          {lead.estimatedCloseDate ?? "—"}
        </span>
      );
    case "createdBy":
      return lead.createdById ? (
        <UserChip
          user={{
            id: lead.createdById,
            displayName: lead.createdByDisplayName,
            photoUrl: null,
          }}
        />
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "createdVia":
      return <Pill kind="provenance" value={lead.createdVia} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.createdAt, prefs, "date")}
        </span>
      );
    case "lastActivityAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.lastActivityAt, prefs)}
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.updatedAt, prefs)}
        </span>
      );
    default:
      return null;
  }
}

function Pill({
  kind,
  value,
}: {
  kind: "status" | "rating" | "source" | "provenance";
  value: string;
}) {
  const palette: Record<string, Record<string, string>> = {
    status: {
      new: "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
      contacted:
        "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
      qualified:
        "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
      unqualified:
        "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
      converted:
        "border-[var(--status-proposal-fg)]/30 bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
      lost: "border-border bg-muted/40 text-muted-foreground/80",
    },
    rating: {
      hot: "border-[var(--priority-very-high-fg)]/30 bg-[var(--priority-very-high-bg)] text-[var(--priority-very-high-fg)]",
      warm: "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      cold: "border-[var(--priority-very-low-fg)]/30 bg-[var(--priority-very-low-bg)] text-[var(--priority-very-low-fg)]",
    },
    source: {
      web: "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
      referral:
        "border-[var(--status-proposal-fg)]/30 bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
      event:
        "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      cold_call:
        "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
      partner:
        "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
      marketing:
        "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
      import: "border-border bg-muted/40 text-muted-foreground",
      other: "border-border bg-muted/40 text-muted-foreground",
    },
    provenance: {
      manual: "border-border bg-muted/40 text-muted-foreground",
      imported:
        "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      api: "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
    },
  };
  const cls =
    palette[kind]?.[value] ?? "border-border bg-muted/40 text-muted-foreground/80";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}
