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
      />
    ),
    [timePrefs, canRemove],
  );

  const renderCard = useCallback(
    (row: MarketingSuppressionRow) => (
      <SuppressionsMobileCard
        row={row}
        timePrefs={timePrefs}
        canRemove={canRemove}
      />
    ),
    [timePrefs, canRemove],
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
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3"
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
        className="min-w-[220px] flex-1 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
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
        className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {SOURCE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      >
        Apply
      </button>
      {filtersAreModified ? (
        <button
          type="button"
          onClick={clearFilters}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          Clear
        </button>
      ) : null}
    </form>
  );

  return (
    <StandardListPage<MarketingSuppressionRow, SuppressionsFilters>
      queryKey={["marketing-suppressions"]}
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
        actions: canAdd ? <AddSuppressionDialog /> : undefined,
      }}
      filtersSlot={filtersSlot}
    />
  );
}

function SuppressionsDesktopRow({
  row,
  timePrefs,
  canRemove,
}: {
  row: MarketingSuppressionRow;
  timePrefs: TimePrefs;
  canRemove: boolean;
}) {
  return (
    <div
      className="flex items-start gap-4 border-b border-border bg-card px-4 py-3 text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {row.email}
      </div>
      <div className="w-32 shrink-0 text-muted-foreground">
        {row.suppressionType}
      </div>
      <div
        className="hidden min-w-0 max-w-[28ch] flex-1 truncate text-muted-foreground lg:block"
        title={row.reason ?? undefined}
      >
        {row.reason ?? "—"}
      </div>
      <div className="w-32 shrink-0 text-muted-foreground">
        <UserTimeClient value={row.suppressedAt} prefs={timePrefs} />
      </div>
      <div className="hidden w-32 shrink-0 truncate text-muted-foreground lg:block">
        {row.addedByName ?? (
          <span className="italic text-muted-foreground/70">system</span>
        )}
      </div>
      {canRemove ? (
        <div className="w-24 shrink-0 text-right">
          <RemoveSuppressionButton
            email={row.email}
            source={row.suppressionType}
            suppressedAt={row.suppressedAt.toISOString()}
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
}: {
  row: MarketingSuppressionRow;
  timePrefs: TimePrefs;
  canRemove: boolean;
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
          />
        </div>
      ) : null}
    </div>
  );
}
