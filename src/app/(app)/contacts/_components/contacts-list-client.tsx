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
import { useClickOutside } from "@/hooks/use-click-outside";
import { cn } from "@/lib/utils";
import { type TimePrefs } from "@/lib/format-time";
import { formatPersonName } from "@/lib/format/person-name";
import {
  AVAILABLE_CONTACT_COLUMNS,
  type ContactColumnKey,
} from "@/lib/contact-view-constants";
import type { ContactRow } from "@/lib/contact-views";
import { ContactListMobile } from "./contact-list-mobile";
import { ContactRowActions } from "./contact-row-actions";
import {
  BulkArchiveBar,
  BulkArchiveProvider,
  RowCheckbox,
} from "./bulk-archive";
import { SortableContactsHeaders } from "./sortable-headers";
import {
  ContactViewToolbar,
  type ContactViewSummary,
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

export interface ContactsListClientProps {
  user: ActorLite;
  timePrefs: TimePrefs;
  activeViewParam: string;
  activeViewName: string;
  activeColumns: ContactColumnKey[];
  baseColumns: ContactColumnKey[];
  views: ContactViewSummary[];
  savedDirtyId: string | null;
  subscribedViewIds: string[];
  defaultViewId: string | null;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  accountOptions: AccountOption[];
  canApplyTags: boolean;
}

interface ContactFilters {
  q: string;
  owner: string; // comma-separated owner ids
  account: string; // comma-separated account ids
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  doNotMail: boolean;
  city: string;
  state: string;
  country: string;
  recentlyUpdatedDays: string;
  tag: string; // comma-separated tag names
}

const EMPTY_FILTERS: ContactFilters = {
  q: "",
  owner: "",
  account: "",
  doNotContact: false,
  doNotEmail: false,
  doNotCall: false,
  doNotMail: false,
  city: "",
  state: "",
  country: "",
  recentlyUpdatedDays: "",
  tag: "",
};

const RECENTLY_UPDATED_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "7", label: "Past 7 days" },
  { value: "30", label: "Past 30 days" },
  { value: "90", label: "Past 90 days" },
];

/**
 * Client-side contacts list. Owns:
 *   - 12-dimension filter state (q, owner, account, 4 do-not-*
 *     booleans, city/state/country, recentlyUpdatedDays, tag).
 *   - TanStack Query cache (via StandardListPage's infinite scroll).
 *   - Bulk selection state for bulk-tag via BulkSelectionProvider.
 *   - Bulk archive selection state via BulkArchiveProvider — separate
 *     surface keyed off per-row RowCheckbox in the desktop table.
 *
 * Saved-view + columns + view selection remain server-driven. The
 * server-rendered shell passes `activeViewParam` and `activeColumns`
 * as props; whenever the view changes via URL (the ContactViewToolbar
 * pushes `/contacts?view=...`), Next.js re-renders the server shell
 * which passes new props in. The outer `key={activeViewParam}` forces
 * a remount on view change so filter state resets.
 */
export function ContactsListClient(props: ContactsListClientProps) {
  return (
    <BulkArchiveProvider>
      <BulkSelectionProvider>
        <ContactsListInner {...props} />
      </BulkSelectionProvider>
    </BulkArchiveProvider>
  );
}

function ContactsListInner({
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
}: ContactsListClientProps) {
  const [filters, setFilters] = useState<ContactFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<ContactFilters>(EMPTY_FILTERS);
  const [loadedIds, setLoadedIds] = useState<string[]>([]);
  const { dispatch } = useBulkSelection();

  const memoizedFilters = useMemo<ContactFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ContactFilters,
      signal?: AbortSignal,
    ): Promise<StandardListPagePage<ContactRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("view", activeViewParam);
      params.set("cols", activeColumns.join(","));
      if (f.q) params.set("q", f.q);
      if (f.owner) params.set("owner", f.owner);
      if (f.account) params.set("account", f.account);
      if (f.doNotContact) params.set("doNotContact", "1");
      if (f.doNotEmail) params.set("doNotEmail", "1");
      if (f.doNotCall) params.set("doNotCall", "1");
      if (f.doNotMail) params.set("doNotMail", "1");
      if (f.city) params.set("city", f.city);
      if (f.state) params.set("state", f.state);
      if (f.country) params.set("country", f.country);
      if (f.recentlyUpdatedDays)
        params.set("recentlyUpdatedDays", f.recentlyUpdatedDays);
      if (f.tag) params.set("tag", f.tag);
      const res = await fetch(`/api/contacts/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) {
        throw new Error(`Could not load contacts (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<ContactRow>;
    },
    [activeViewParam, activeColumns],
  );

  // Wrapped fetchPage that tracks loaded IDs + syncs selection counters
  // so the bulk-action toolbar shows accurate counts. Forwards the
  // AbortSignal so a stale in-flight request cancelled by TanStack
  // Query (filter / view change) does NOT write into setLoadedIds.
  const fetchPageInstrumented = useCallback(
    async (cursor: string | null, f: ContactFilters, signal?: AbortSignal) => {
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
    (contact: ContactRow) => (
      <ContactDesktopRow
        contact={contact}
        columns={activeColumns}
        timePrefs={timePrefs}
        canDelete={user.isAdmin || contact.ownerId === user.id}
      />
    ),
    [activeColumns, timePrefs, user.id, user.isAdmin],
  );

  const renderCard = useCallback(
    (contact: ContactRow) => (
      <ContactListMobile
        rows={[
          {
            id: contact.id,
            firstName: contact.firstName,
            lastName: contact.lastName,
            jobTitle: contact.jobTitle,
            email: contact.email,
            accountName: contact.accountName,
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
      filters.doNotContact ||
      filters.doNotEmail ||
      filters.doNotCall ||
      filters.doNotMail ||
      filters.city ||
      filters.state ||
      filters.country ||
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
  const viewModified = columnsModified || filtersAreModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (filters.q) modifiedFields.push("search");
  if (
    filters.owner ||
    filters.account ||
    filters.doNotContact ||
    filters.doNotEmail ||
    filters.doNotCall ||
    filters.doNotMail ||
    filters.city ||
    filters.state ||
    filters.country ||
    filters.recentlyUpdatedDays ||
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
          md inside ContactViewToolbar itself. */}
      <ContactViewToolbar
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
        defaultViewId={defaultViewId}
      />

      {/* Selection bar (renders when ≥1 row checked). Desktop only —
          BulkArchive uses per-row RowCheckbox which is desktop-table
          specific. */}
      <div className="hidden md:block">
        <BulkArchiveBar />
      </div>

      <ContactFiltersBar
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
      <SortableContactsHeaders
        initialColumns={activeColumns}
        activeViewId={activeViewParam}
      />
    </table>
  );

  const headerActions = (
    <>
      {user.isAdmin ? (
        <Link
          href="/contacts/archived"
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
        >
          Archived
        </Link>
      ) : null}
      <Link
        href="/contacts/new"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        + Add contact
      </Link>
    </>
  );

  return (
    <StandardListPage<ContactRow, ContactFilters>
      entityType="contact"
      queryKey={["contacts", activeViewParam, activeColumns.join(",")]}
      fetchPage={fetchPageInstrumented}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={72}
      emptyState={
        <StandardEmptyState
          title="No contacts match this view."
          description={
            filtersAreModified
              ? "Adjust or clear the filters to see records here."
              : undefined
          }
        />
      }
      header={{
        title: "Contacts",
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
  filters: ContactFilters;
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
      entity: "contact" as const,
      filters: { ...filters, view: activeViewParam },
    };
  }, [scope, loadedIds, filters, activeViewParam]);

  return (
    <BulkTagButton
      entityType="contact"
      scope={bulkScope}
      availableTags={availableTags}
      canApply={canApply}
    />
  );
}

/**
 * Desktop row. Flex layout matching the column-header layout above —
 * each column is a flex-1 cell so widths align with the header row
 * driven by SortableContactsHeaders. Leading selection-checkbox cell
 * + trailing actions cell stay fixed-width.
 */
function ContactDesktopRow({
  contact,
  columns,
  timePrefs,
  canDelete,
}: {
  contact: ContactRow;
  columns: ContactColumnKey[];
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
        <RowCheckbox id={contact.id} version={contact.version} />
      </div>
      {columns.map((c) => {
        const colLabel =
          AVAILABLE_CONTACT_COLUMNS.find((col) => col.key === c)?.label ?? c;
        return (
          <div
            key={c}
            data-label={colLabel}
            className="min-w-0 flex-1 truncate px-5 py-3"
            style={{ flexBasis: "140px" }}
          >
            {renderCell(contact, c, timePrefs)}
          </div>
        );
      })}
      <div className="w-10 shrink-0 px-2 py-3">
        <ContactRowActions
          contactId={contact.id}
          contactName={formatPersonName(contact)}
          canDelete={canDelete}
        />
      </div>
    </div>
  );
}

function ContactFiltersBar({
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
  draft: ContactFilters;
  onDraftChange: (next: ContactFilters) => void;
  onApply: () => void;
  onClear: () => void;
  onMobileImmediate: (next: ContactFilters) => void;
  allTags: AvailableTag[];
  ownerOptions: OwnerOption[];
  accountOptions: AccountOption[];
  hasActiveFilters: boolean;
}) {
  const setField = <K extends keyof ContactFilters>(
    key: K,
    value: ContactFilters[K],
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
            placeholder="Search name, email, title…"
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
          placeholder="Search name / email / title…"
          className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
        />

        {/* Mobile chip-style selects (auto-apply). */}
        <div className="contents md:hidden">
          {accountOptions.length > 0 ? (
            <ControlledMobileSelect
              value={draft.account}
              onChange={(v) =>
                onMobileImmediate({ ...draft, account: v })
              }
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
            value={draft.recentlyUpdatedDays}
            onChange={(v) =>
              onMobileImmediate({ ...draft, recentlyUpdatedDays: v })
            }
            options={RECENTLY_UPDATED_OPTIONS}
            placeholder="Updated"
          />
          <ControlledMobileBoolChip
            checked={draft.doNotContact}
            onChange={(v) =>
              onMobileImmediate({ ...draft, doNotContact: v })
            }
            label="DNC"
          />
          <ControlledMobileBoolChip
            checked={draft.doNotEmail}
            onChange={(v) =>
              onMobileImmediate({ ...draft, doNotEmail: v })
            }
            label="No email"
          />
          <ControlledMobileBoolChip
            checked={draft.doNotCall}
            onChange={(v) =>
              onMobileImmediate({ ...draft, doNotCall: v })
            }
            label="No call"
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

        {/* Desktop selects + Apply. */}
        <div className="hidden items-center gap-2 md:flex md:gap-3">
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
            value={draft.recentlyUpdatedDays}
            onChange={(v) => setField("recentlyUpdatedDays", v)}
            options={RECENTLY_UPDATED_OPTIONS}
            placeholder="Updated"
          />
          <ControlledBoolChip
            checked={draft.doNotContact}
            onChange={(v) => setField("doNotContact", v)}
            label="DNC"
          />
          <ControlledBoolChip
            checked={draft.doNotEmail}
            onChange={(v) => setField("doNotEmail", v)}
            label="No email"
          />
          <ControlledBoolChip
            checked={draft.doNotCall}
            onChange={(v) => setField("doNotCall", v)}
            label="No call"
          />
          <ControlledBoolChip
            checked={draft.doNotMail}
            onChange={(v) => setField("doNotMail", v)}
            label="No mail"
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

function ControlledBoolChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition focus-within:ring-2 focus-within:ring-ring/40",
        checked
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border bg-muted/40 text-primary focus:ring-ring"
      />
      <span>{label}</span>
    </label>
  );
}

function ControlledMobileBoolChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-within:ring-2 focus-within:ring-ring/40",
        checked
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border bg-muted/40 text-primary focus:ring-ring"
      />
      <span>{label}</span>
    </label>
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

function renderCell(
  row: ContactRow,
  col: ContactColumnKey,
  prefs: TimePrefs,
) {
  switch (col) {
    case "firstName":
      return (
        <Link
          href={`/contacts/${row.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.firstName || "(Unnamed)"}
        </Link>
      );
    case "lastName":
      return <span className="text-foreground">{row.lastName ?? "—"}</span>;
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
    case "jobTitle":
      return (
        <span className="text-muted-foreground">{row.jobTitle ?? "—"}</span>
      );
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
    case "phone":
      return <span className="text-muted-foreground">{row.phone ?? "—"}</span>;
    case "mobilePhone":
      return (
        <span className="text-muted-foreground">{row.mobilePhone ?? "—"}</span>
      );
    case "doNotContact":
      return row.doNotContact ? (
        <span className="inline-flex items-center rounded-full border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--status-lost-fg)]">
          DNC
        </span>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "doNotMail":
      return row.doNotMail ? (
        <span className="inline-flex items-center rounded-full border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--status-lost-fg)]">
          No mail
        </span>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "city":
      return <span className="text-muted-foreground">{row.city ?? "—"}</span>;
    case "state":
      return <span className="text-muted-foreground">{row.state ?? "—"}</span>;
    case "postalCode":
      return (
        <span className="text-muted-foreground">{row.postalCode ?? "—"}</span>
      );
    case "country":
      return (
        <span className="text-muted-foreground">{row.country ?? "—"}</span>
      );
    case "birthdate":
      return (
        <span className="text-muted-foreground">{row.birthdate ?? "—"}</span>
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
