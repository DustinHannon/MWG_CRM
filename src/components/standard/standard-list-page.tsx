"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StandardEmptyState } from "./standard-empty-state";
import { StandardLoadingState } from "./standard-loading-state";
import {
  StandardPageHeader,
  type StandardPageHeaderProps,
} from "./standard-page-header";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";

/**
 * Page of items returned by `fetchPage`. The cursor model is opaque —
 * callers serialize their own cursor token; the shell only forwards it.
 */
export interface StandardListPagePage<T> {
  data: T[];
  nextCursor: string | null;
  total: number;
}

/**
 * Dual-slot shape for the `bulkActions` prop. The `banner` renders
 * inside the sticky chrome group between the filter slot and the
 * result list. The `toolbar` renders as a viewport-fixed overlay
 * anchored to the bottom of the page.
 */
export interface BulkActionsSlot {
  banner?: ReactNode;
  toolbar?: ReactNode;
}

/**
 * Render contract for the canonical list-page shell.
 *
 * Generic over `T` (the row type) and `F` (the filters object that
 * is included in the query key and forwarded to `fetchPage`). The
 * shell owns infinite-scroll fetching, row virtualization (desktop and
 * mobile separately), keyboard skip-links, an ARIA live region, and
 * scroll restoration. Pages supply `renderRow` (desktop) and
 * `renderCard` (mobile) — both containers always render; CSS hides
 * the inactive one (`md:hidden` for the mobile container, `hidden
 * md:block` for the desktop container).
 *
 * Bulk-selection state and bulk-action UI is rendered by a follow-on
 * dispatch and accepted here as an `unknown` slot to keep the shell
 * agnostic until that work lands.
 */
export interface StandardListPageProps<T, F> {
  /** TanStack Query key. Must include every filter that changes the result set. */
  queryKey: readonly unknown[];
  /**
   * Page loader. Receives the current cursor (null for first page) and
   * the active filter object. Returns the data array, the next cursor
   * (null when the end of the result set is reached), and the total
   * count (used for the "Showing N of M" line and the load-more label).
   */
  fetchPage: (
    cursor: string | null,
    filters: F,
    signal?: AbortSignal,
  ) => Promise<StandardListPagePage<T>>;
  /** Active filters. Spread into the query key by the caller — included verbatim in the fetch. */
  filters: F;
  /** Desktop row renderer. Called once per row; the shell owns the wrapping `<div>` and measureElement ref. */
  renderRow: (item: T, index: number) => ReactNode;
  /** Mobile card renderer. Same contract as `renderRow`. */
  renderCard: (item: T, index: number) => ReactNode;
  /** Initial estimate for desktop row height (px). Variable height supported via measureElement. */
  rowEstimateSize: number;
  /** Initial estimate for mobile card height (px). */
  cardEstimateSize: number;
  /** Rendered in place of the row list when the first page returns zero items. */
  emptyState: ReactNode;
  /** Optional error renderer. Defaults to a typed error state with a retry button. */
  errorState?: (error: Error, retry: () => void) => ReactNode;
  /** Optional loading renderer for the very first page. Defaults to `<StandardLoadingState variant="table" />`. */
  loadingState?: ReactNode;
  /**
   * Slot for bulk-selection banner + toolbar. The `banner` renders
   * inside the sticky chrome group between the filter slot and the
   * result list — typically a `<BulkSelectionBanner />`. The
   * `toolbar` renders as a viewport-fixed overlay anchored to the
   * bottom of the page — typically a `<BulkActionToolbar>`. The
   * toolbar uses `position: fixed` so it does not move with the
   * scroll surface.
   */
  bulkActions?: BulkActionsSlot;
  /** Page size hint forwarded to `fetchPage` callers via the Load-more label. Default 50. */
  pageSize?: number;
  /** Header props — forwarded to `<StandardPageHeader />`. */
  header: StandardPageHeaderProps;
  /** Optional filter bar rendered between the header and the result list. */
  filtersSlot?: ReactNode;
  /**
   * Optional column-header slot. Rendered in its own sticky tier below the
   * main chrome group (z-15) and inside the horizontal-scroll wrapper that
   * surrounds the row list, so column headers stay aligned with rows when
   * the table is wider than the viewport. Pages without a tabular layout
   * (mobile-cards-only, dashboards) omit this slot.
   */
  columnHeaderSlot?: ReactNode;
  className?: string;
}


/**
 * Canonical list-page shell. Owns infinite scroll, virtualization,
 * scroll restoration, accessibility scaffolding (skip-links, ARIA live
 * region), and empty/loading/error states.
 *
 * Data-shape constraints:
 * `fetchPage` MUST return an opaque cursor string (or null when
 * exhausted) so the shell stays cursor-paginated independent of the
 * underlying SQL strategy.
 * `total` MAY be the page's running total or the overall result-set
 * total — the shell uses it only for the "Showing N of M" affordance.
 *
 * Auto-fetch:
 * The next page is fetched automatically when the index-based sentinel
 * (the last virtual row) enters the rendered window — unconditionally,
 * on every environment. `prefers-reduced-motion` is intentionally NOT
 * honored: this is an internal tool with a consistent-behavior
 * requirement across Windows Server / RDP / VDI / desktop / mobile.
 * There is no "Load more" button; scrolling is the only pagination
 * affordance.
 */
export function StandardListPage<T, F>({
  queryKey,
  fetchPage,
  filters,
  renderRow,
  renderCard,
  rowEstimateSize,
  cardEstimateSize,
  emptyState,
  errorState,
  loadingState,
  bulkActions,
  header,
  filtersSlot,
  columnHeaderSlot,
  className,
}: StandardListPageProps<T, F>) {
  const query = useInfiniteQuery<StandardListPagePage<T>, Error>({
    queryKey: [...queryKey, filters],
    queryFn: ({ pageParam, signal }) =>
      fetchPage((pageParam as string | null) ?? null, filters, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError,
    isPending,
    refetch,
  } = query;

  // Flatten pages → rows.
  const rows = useMemo<T[]>(
    () => data?.pages.flatMap((p) => p.data) ?? [],
    [data],
  );
  const total = data?.pages.at(-1)?.total ?? rows.length;
  const loadedCount = rows.length;

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // ---- ARIA live region announcement ----
  const liveRef = useRef<HTMLDivElement | null>(null);
  const lastAnnouncedCount = useRef(0);
  const lastQueryKeyRef = useRef<string>("");
  // Stable serialization of the active query identity. When the user
  // changes filter / view / sort, this string changes and the live
  // region's "loaded N more" counter resets so it doesn't announce
  // (new first page size − old loaded count) as if the user had
  // paginated.
  const queryKeySerialized = useMemo(
    () => JSON.stringify([...queryKey, filters]),
    [queryKey, filters],
  );
  useEffect(() => {
    if (!liveRef.current) return;
    if (lastQueryKeyRef.current !== queryKeySerialized) {
      lastAnnouncedCount.current = 0;
      lastQueryKeyRef.current = queryKeySerialized;
    }
    if (rows.length === 0) return;
    const delta = rows.length - lastAnnouncedCount.current;
    if (delta > 0 && lastAnnouncedCount.current > 0) {
      liveRef.current.textContent = `Loaded ${delta} more ${delta === 1 ? "item" : "items"}. ${rows.length} of ${total} shown.`;
    }
    lastAnnouncedCount.current = rows.length;
  }, [rows.length, total, queryKeySerialized]);

  // Window-scoped scroll restoration. Owned at the page level so the
  // single restoration applies regardless of which virtualized
  // container (desktop / mobile) is visible — both scroll the same
  // window. Per-container scope discriminators are unnecessary under
  // window virtualization.
  useScrollRestoration();

  return (
    <div
      className={["space-y-3", className ?? ""].filter(Boolean).join(" ")}
    >
      {/* Skip-links: visible on focus only, follow Tab order. The
          "Skip to filters" link only renders when a filtersSlot was
          provided so it can never point at a missing anchor. */}
      {filtersSlot ? (
        <a
          href="#list-filters"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-1.5 focus:text-sm focus:text-popover-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to filters
        </a>
      ) : null}
      <a
        href="#list-actions"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-1.5 focus:text-sm focus:text-popover-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to actions
      </a>
      <a
        href="#list-results"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-1.5 focus:text-sm focus:text-popover-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to results
      </a>

      {/* Sticky chrome group — page header + filters + bulk banner pin
          to the viewport beneath the AppShell TopBar (h-14). One sticky
          wrapper avoids per-element z-index stacking and the "filters
          appear to scroll over the title" jitter that comes from
          multiple sticky siblings with different top offsets. The group
          sits at `top-14` so it docks immediately below the TopBar
          (z-30); group itself is z-20 so it composes correctly with the
          bulk-action toolbar (z-20, bottom). The column-header row
          renders inside the result list's horizontal-scroll wrapper so
          it stays aligned with rows during horizontal scroll; it is not
          vertically sticky because `overflow-x: auto` creates a
          scrolling-mechanism context that would pin descendants
          relative to the wrapper instead of the viewport. */}
      <div className="sticky top-14 z-20 -mx-4 space-y-3 border-b border-border/40 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6 xl:-mx-10 xl:px-10">
        <div id="list-actions">
          <StandardPageHeader {...header} />
        </div>

        {filtersSlot ? <div id="list-filters">{filtersSlot}</div> : null}

        {bulkActions?.banner ? <div>{bulkActions.banner}</div> : null}
      </div>

      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        ref={liveRef}
      />

      <div id="list-results">
        {/* "Showing N of M" caption — sits above the table region, not
            inside the sticky chrome. Scrolls away with the data so it
            doesn't visually compete with the column-header tier during
            scroll. Screen-reader announcements come from the live
            region above; this caption is plain text only. */}
        {!isPending && !isError && rows.length > 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {`Showing ${loadedCount.toLocaleString()} of ${total.toLocaleString()}`}
          </p>
        ) : null}

        {isPending ? (
          loadingState ?? <StandardLoadingState variant="table" />
        ) : isError ? (
          errorState ? (
            errorState(error as Error, retry)
          ) : (
            <DefaultErrorState error={error as Error} onRetry={retry} />
          )
        ) : rows.length === 0 ? (
          emptyState ?? (
            <StandardEmptyState
              title="No results"
              description="Adjust the filters to see records here."
            />
          )
        ) : (
          <>
            {/* Desktop region: horizontal-scroll wrapper hosts the
                column-header row AND the row list, so headers stay
                aligned with rows when the table is wider than the
                viewport. Column header is NOT vertically sticky —
                using `overflow-x: auto` on the wrapper creates a
                scrolling-mechanism context that breaks viewport-scoped
                sticky for descendants (sticky elements would pin
                relative to the wrapper, not the viewport). The chrome
                group above remains sticky and provides the persistent
                page-context affordance during deep scroll. */}
            <div className="hidden md:block">
              <div className="overflow-x-auto overflow-y-hidden rounded-lg border border-border bg-card">
                <div className="min-w-max">
                  {columnHeaderSlot ? (
                    <div className="border-b border-border bg-muted/40">
                      {columnHeaderSlot}
                    </div>
                  ) : null}
                  <VirtualScrollContainer
                    rows={rows}
                    renderItem={renderRow}
                    estimateSize={rowEstimateSize}
                    hasNextPage={Boolean(hasNextPage)}
                    isFetchingNextPage={isFetchingNextPage}
                    fetchNextPage={fetchNextPage}
                  />
                </div>
              </div>
            </div>

            {/* Mobile virtualized cards. Hidden md and up. No horizontal-
                scroll wrapper — cards adapt to the viewport width. */}
            <div className="rounded-lg border border-border bg-card md:hidden">
              <VirtualScrollContainer
                rows={rows}
                renderItem={renderCard}
                estimateSize={cardEstimateSize}
                hasNextPage={Boolean(hasNextPage)}
                isFetchingNextPage={isFetchingNextPage}
                fetchNextPage={fetchNextPage}
              />
            </div>

            {/* No "Load more" button — scrolling drives the index
                sentinel (auto-fetch is unconditional). Terminal line
                shows only once every page is loaded. */}
            {!hasNextPage ? (
              <div className="flex items-center justify-center pt-2">
                <p className="text-xs text-muted-foreground">
                  {`End of results — ${total.toLocaleString()} ${total === 1 ? "item" : "items"} shown`}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Bulk action toolbar. Rendered last so it sits in stacking
          order above the scroll surface; visibility is owned by the
          toolbar component (renders null when selection scope is
          `none`). The toolbar itself uses `position: fixed` so it
          does not need to live inside the scroll container. */}
      {bulkActions?.toolbar ?? null}
    </div>
  );
}

// ---------- internal pieces ----------

interface VirtualScrollContainerProps<T> {
  rows: T[];
  renderItem: (item: T, index: number) => ReactNode;
  estimateSize: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Virtualized scroll surface with variable-height rows, an
 * intersection sentinel that triggers `fetchNextPage`, and per-URL
 * scroll restoration.
 *
 * Uses `useWindowVirtualizer` so the page itself is the scroll surface
 * (window). The list reports its `offsetTop` as `scrollMargin` so the
 * virtualizer can translate virtual-item offsets back into the list
 * container's local coordinate space. The container has NO height
 * constraint and NO `overflow-auto` — it grows to the virtualizer's
 * total size and the document body scrolls.
 *
 * See CLAUDE.md "List page scroll behavior" for the architectural
 * contract.
 */
function VirtualScrollContainer<T>({
  rows,
  renderItem,
  estimateSize,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: VirtualScrollContainerProps<T>) {
  // TanStack Virtual returns functions that cannot be safely memoized;
  // opt this component out of the React Compiler to preserve correct
  // scroll measurements. See @tanstack/react-virtual docs on
  // `useWindowVirtualizer` and React Compiler interop.
  "use no memo";
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Track the container's offset from the page top. Window virtualizer
  // needs this so `virtualItem.start` (which is in window coordinates)
  // translates back to the list's local coordinate system. Measured in
  // a layout effect so the value is correct on the first paint;
  // resize/scroll events update it for responsive layouts and dynamic
  // chrome (e.g., the sticky filter group changing height as filters
  // wrap on narrow viewports).
  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    const node = parentRef.current;
    if (!node) return;
    const measure = () => {
      const here = parentRef.current;
      if (!here) return;
      const offset = here.getBoundingClientRect().top + window.scrollY;
      // Only update state when the offset materially changes — sub-
      // pixel jitter from re-measurements would otherwise cascade
      // into useWindowVirtualizer re-renders and visible row
      // repositioning. 1px threshold is enough for any practical
      // chrome shift.
      setListOffset((prev) =>
        Math.abs(prev - offset) >= 1 ? offset : prev,
      );
    };
    measure();
    // ResizeObserver on document.body catches the cases where chrome
    // above the list changes height (filter row wraps onto a second
    // row at narrower widths, MODIFIED badge appears/disappears,
    // bulk-selection banner shows/hides) without firing a `resize`
    // event. Falls back gracefully when RO is unavailable (very old
    // browsers / SSR — we're inside useLayoutEffect so window exists).
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measure())
        : null;
    observer?.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Count includes a trailing sentinel row when more pages exist.
  const count = hasNextPage ? rows.length + 1 : rows.length;

  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => estimateSize,
    overscan: 6,
    scrollMargin: listOffset,
    // measureElement allows variable-height rows; we attach it via ref below.
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Sentinel-driven auto-fetch (original index-based sentinel). Always
  // on — no prefers-reduced-motion gate, no button.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    const last = virtualItems.at(-1);
    if (!last) return;
    // The sentinel is the last virtual row when hasNextPage is true.
    if (last.index >= rows.length - 1) {
      fetchNextPage();
    }
  }, [
    virtualItems,
    rows.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  return (
    <div
      ref={parentRef}
      role="feed"
      aria-busy={isFetchingNextPage}
      className="relative bg-card"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((virtualItem) => {
          const isSentinel = virtualItem.index >= rows.length;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {isSentinel ? (
                <SkeletonRow estimateSize={estimateSize} />
              ) : (
                renderItem(rows[virtualItem.index] as T, virtualItem.index)
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkeletonRow({ estimateSize }: { estimateSize: number }) {
  return (
    <div
      className="flex items-center gap-3 border-b border-border px-4"
      style={{ minHeight: `${estimateSize}px` }}
      aria-hidden="true"
    >
      <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/5 animate-pulse rounded bg-muted" />
      <div className="ml-auto h-3 w-16 animate-pulse rounded bg-muted" />
    </div>
  );
}

function DefaultErrorState({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center"
    >
      <p className="text-sm font-medium text-foreground">
        Could not load results
      </p>
      <p className="text-xs text-muted-foreground">{error.message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Retry
      </button>
    </div>
  );
}
