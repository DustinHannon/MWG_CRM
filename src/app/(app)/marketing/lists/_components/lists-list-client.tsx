"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import type { MarketingListRow } from "@/lib/marketing/lists/cursor";

interface ListsListClientProps {
  timePrefs: TimePrefs;
  canCreate: boolean;
}

interface ListsFilters {
  q: string;
  type: "all" | "dynamic" | "static_imported";
}

const EMPTY_FILTERS: ListsFilters = {
  q: "",
  type: "all",
};

const TYPE_OPTIONS: ReadonlyArray<{
  value: ListsFilters["type"];
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "dynamic", label: "Dynamic" },
  { value: "static_imported", label: "Static" },
];

export function ListsListClient({ timePrefs, canCreate }: ListsListClientProps) {
  const [filters, setFilters] = useState<ListsFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<ListsFilters>(EMPTY_FILTERS);

  const memoizedFilters = useMemo<ListsFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ListsFilters,
    ): Promise<StandardListPagePage<MarketingListRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.type !== "all") params.set("type", f.type);
      const res = await fetch(`/api/marketing/lists/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load lists (${res.status})`);
      }
      const json = (await res.json()) as {
        data: Array<
          Omit<MarketingListRow, "updatedAt" | "lastRefreshedAt"> & {
            updatedAt: string;
            lastRefreshedAt: string | null;
          }
        >;
        nextCursor: string | null;
        total: number;
      };
      return {
        data: json.data.map((r) => ({
          ...r,
          updatedAt: new Date(r.updatedAt),
          lastRefreshedAt: r.lastRefreshedAt ? new Date(r.lastRefreshedAt) : null,
        })),
        nextCursor: json.nextCursor,
        total: json.total,
      };
    },
    [],
  );

  const renderRow = useCallback(
    (list: MarketingListRow) => (
      <ListsDesktopRow list={list} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (list: MarketingListRow) => (
      <ListsMobileCard list={list} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(filters.q || filters.type !== "all");

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
          placeholder="Search lists"
          className="h-11 min-w-[200px] flex-1 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
        />
        {/* Type pills: tap auto-applies on both mobile and desktop. */}
        <div className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full border border-border bg-card p-1 md:rounded-md">
          {TYPE_OPTIONS.map((opt) => {
            const isActive = draft.type === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  const next = { ...draft, type: opt.value };
                  setDraft(next);
                  setFilters(next);
                }}
                className={
                  isActive
                    ? "h-9 rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground md:rounded-md"
                    : "h-9 rounded-full px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted/60 md:rounded-md"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
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

  // Desktop column header. 6 cells matching desktop row layout.
  const LIST_COLS = 6;
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-xs font-medium uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${LIST_COLS * 140 + 40}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Name
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Type
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-right"
        style={{ flexBasis: "140px" }}
      >
        Members
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Last refreshed
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Created by
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Updated
      </div>
    </div>
  );

  const headerActions = canCreate ? (
    <div className="flex flex-wrap gap-2">
      <Link
        href="/marketing/lists/new?type=dynamic"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
      >
        New dynamic list
      </Link>
      <Link
        href="/marketing/lists/new/import"
        className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground/90 whitespace-nowrap transition hover:bg-muted"
      >
        New static list
      </Link>
    </div>
  ) : null;

  return (
    <StandardListPage<MarketingListRow, ListsFilters>
      entityType="marketing_list"
      queryKey={["marketing-lists"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={120}
      emptyState={
        <StandardEmptyState
          title="No lists match"
          description={
            filtersAreModified
              ? "Try a different search or list type."
              : "Create a dynamic list from a filter or import a static list from Excel."
          }
        />
      }
      header={{
        title: "Lists",
        description: "Recipient segments for campaigns.",
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
      columnHeaderSlot={columnHeaderSlot}
    />
  );
}

function ListsDesktopRow({
  list,
  timePrefs,
}: {
  list: MarketingListRow;
  timePrefs: TimePrefs;
}) {
  // 6 cells matching columnHeaderSlot. flex-basis 140px per cell + row
  // min-width keep cells from squeezing below 140px when the table is
  // wider than the viewport.
  const minRowWidth = 6 * 140 + 40;
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
      style={{ minWidth: `${minRowWidth}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <Link
          href={`/marketing/lists/${list.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {list.name}
        </Link>
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <ListTypePill type={list.listType} />
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-right text-foreground tabular-nums"
        style={{ flexBasis: "140px" }}
      >
        {list.memberCount.toLocaleString()}
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        {list.listType === "static_imported" ? (
          <span className="text-muted-foreground/70">—</span>
        ) : list.lastRefreshedAt ? (
          <UserTimeClient value={list.lastRefreshedAt} prefs={timePrefs} />
        ) : (
          "Never"
        )}
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        {list.createdByName ?? "—"}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        <UserTimeClient value={list.updatedAt} prefs={timePrefs} />
      </div>
    </div>
  );
}

function ListsMobileCard({
  list,
  timePrefs,
}: {
  list: MarketingListRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/marketing/lists/${list.id}`}
      className="block rounded-md border border-border bg-card p-3 transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">
          {list.name}
        </span>
        <ListTypePill type={list.listType} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {list.memberCount.toLocaleString()} members
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {list.listType === "static_imported"
            ? "Static"
            : list.lastRefreshedAt
              ? "Refreshed "
              : "Never refreshed"}
          {list.listType === "dynamic" && list.lastRefreshedAt ? (
            <UserTimeClient
              value={list.lastRefreshedAt}
              prefs={timePrefs}
            />
          ) : null}
        </span>
        <UserTimeClient value={list.updatedAt} prefs={timePrefs} />
      </div>
    </Link>
  );
}

function ListTypePill({ type }: { type: "dynamic" | "static_imported" }) {
  const label = type === "dynamic" ? "Dynamic" : "Static";
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}
