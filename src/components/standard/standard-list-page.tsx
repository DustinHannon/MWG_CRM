"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useInView } from "react-intersection-observer";
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
 * Snapshot emitted by `onLoadedIds` after each page settles. `ids` is
 * the live accumulator Set (every row identity seen this query session,
 * monotonic across `maxPages` eviction); treat it as read-only.
 */
export interface LoadedIdsSnapshot {
  ids: ReadonlySet<string>;
  count: number;
  total: number;
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
   * count (used for the "Showing N of M" line).
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
  /**
   * Stable per-row identity. Powers the monotonic "Showing N of M"
   * counter, which must keep growing as the user scrolls even though
   * `maxPages` evicts the oldest in-memory page. Defaults to a typed
   * read of `(item).id` (string | number) with an index fallback —
   * no `any`, no `T extends { id }` constraint imposed on callers.
   */
  getRowId?: (item: T, index: number) => string;
  /**
   * Fired after each page settles (post-accumulate). Lets bulk-selection
   * consumers consume the shell's loaded-id accumulator instead of
   * reimplementing one inside a wrapped `fetchPage`. The `ids` Set is
   * the live accumulator — read-only; do not mutate.
   */
  onLoadedIds?: (snapshot: LoadedIdsSnapshot) => void;
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
 * How many in-memory pages the shell retains. `useInfiniteQuery` trims
 * the oldest page on each forward `fetchNextPage` once this is exceeded
 * (forward-only — no `getPreviousPageParam` is defined, so query-core
 * never runs the backward `addToStart` path). Memory is therefore
 * bounded at `serverPageSize × MAX_PAGES` rows regardless of how far
 * the user scrolls. The loaded-id accumulator below is what keeps the
 * "Showing N of M" counter monotonic across this eviction.
 */
const MAX_PAGES = 5;

/**
 * Default `getRowId`. Reads a string/number `id` without an `any` cast
 * and without forcing `T extends { id }` on callers. The index
 * fallback exists ONLY so a malformed row shape doesn't throw — it is
 * NOT eviction-safe (the same logical row gets a new index after a
 * maxPages trim and would re-enter the Set under a different key,
 * inflating the count). Every current StandardListPage row type has a
 * stable `id`, so the fallback is never reached; any future consumer
 * whose rows lack a stable id MUST pass an explicit `getRowId`.
 */
function defaultGetRowId(item: unknown, index: number): string {
  if (item && typeof item === "object" && "id" in item) {
    const v = (item as { id: unknown }).id;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return String(index);
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
 * A first page that returns zero rows WITH a non-null cursor renders
 * the empty state and does not auto-advance (pre-existing contract):
 * `fetchPage` must not return an empty first page while more data
 * exists behind the cursor.
 *
 * Auto-fetch:
 * The next page is fetched when a 1px IntersectionObserver sentinel,
 * rendered after the virtualized list, scrolls within 200px of the
 * viewport (`react-intersection-observer`). A synchronous ref latch
 * guarantees one in-flight fetch per settle even under React batching.
 * There is no "Load more" button and no `prefers-reduced-motion` gate:
 * scrolling is the only pagination affordance and auto-fetch runs
 * unconditionally on every environment (Windows Server / RDP / VDI /
 * desktop / mobile). Memory is bounded by `MAX_PAGES`.
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
  getRowId,
  onLoadedIds,
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
    // Forward-only window. No getPreviousPageParam → eviction is
    // exclusively the forward addToEnd trim (verified against the
    // installed @tanstack/query-core infiniteQueryBehavior source).
    // A refetch/invalidation of the SAME query replays forward from
    // oldPageParams[0] (the oldest *surviving* cursor after eviction),
    // not from page 1 — standard query-core maxPages behavior. The
    // first-load error path still restarts from null (no pages cached
    // yet), so DefaultErrorState's Retry button is page 1.
    maxPages: MAX_PAGES,
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

  // Flatten the in-memory page window → rows. With maxPages this is a
  // sliding window: the oldest page is gone from `rows` after eviction.
  // The loaded-id accumulator below preserves the cumulative count.
  const rows = useMemo<T[]>(
    () => data?.pages.flatMap((p) => p.data) ?? [],
    [data],
  );
  const total = data?.pages.at(-1)?.total ?? rows.length;

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  // ---- Monotonic loaded-id accumulator ----
  // The "Showing N of M" counter must keep climbing as the user scrolls
  // even though `rows` is a bounded window. We accumulate every row
  // identity ever seen this query session into a Set that only grows;
  // it resets when the query identity (filters / view / sort) changes.
  //
  // No page is ever missed: (1) the fetch latch + isFetchingNextPage
  // serialize fetches so page N+1 cannot start until page N has
  // settled AND a render has occurred; (2) React flushes a commit's
  // passive effects before the next commit's, so the effect below runs
  // with every distinct `rows` value (every page is in `rows` for at
  // least one observed commit before it can be evicted); (3) the effect
  // unions the FULL current `rows`, not a delta, so observing any
  // commit that contained a page captures all of that page's ids. The
  // Set is therefore complete regardless of how fast the user scrolls.
  const resolveRowId = getRowId ?? defaultGetRowId;
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const accumKeyRef = useRef<string>("");
  const [loaded, setLoaded] = useState<{ count: number; total: number }>({
    count: 0,
    total: 0,
  });

  // Stable serialization of the active query identity. When the user
  // changes filter / view / sort this string changes: the accumulator
  // and the live-region counter both reset so they never report a
  // stale delta as if the user had paginated.
  const queryKeySerialized = useMemo(
    () => JSON.stringify([...queryKey, filters]),
    [queryKey, filters],
  );

  useEffect(() => {
    if (accumKeyRef.current !== queryKeySerialized) {
      loadedIdsRef.current = new Set();
      accumKeyRef.current = queryKeySerialized;
    }
    const set = loadedIdsRef.current;
    for (let i = 0; i < rows.length; i++) {
      set.add(resolveRowId(rows[i] as T, i));
    }
    const count = set.size;
    setLoaded((prev) =>
      prev.count === count && prev.total === total
        ? prev
        : { count, total },
    );
  }, [rows, total, queryKeySerialized, resolveRowId]);

  // Emit the snapshot only when it materially changes (not every
  // render) so bulk-selection consumers can wire `onLoadedIds`
  // straight into a reducer dispatch without an extra equality guard.
  useEffect(() => {
    if (!onLoadedIds) return;
    if (loaded.count === 0 && loaded.total === 0) return;
    onLoadedIds({
      ids: loadedIdsRef.current,
      count: loaded.count,
      total: loaded.total,
    });
  }, [loaded.count, loaded.total, onLoadedIds]);

  // Caption source. Fall back to the in-memory window length on the
  // first paint (before the accumulator effect commits) so the caption
  // never flashes "0 of 0"; thereafter `loaded.count` is monotonic
  // under maxPages eviction. Eviction ≠ deletion, though: a same-query
  // refetch after another user deletes records can lower `total` below
  // the accumulated id count, so clamp to never render N > M.
  const captionTotal = loaded.total || total;
  const captionCount = Math.min(loaded.count || rows.length, captionTotal);

  // ---- ARIA live region announcement ----
  const liveRef = useRef<HTMLDivElement | null>(null);
  const lastAnnouncedCount = useRef(0);
  const lastQueryKeyRef = useRef<string>("");
  // This effect may read a one-render-stale `captionCount` right after
  // a query-identity change (the accumulator effect's setLoaded commits
  // next render). That is safe: on identity change lastAnnouncedCount
  // resets to 0, so the `lastAnnouncedCount.current > 0` guard
  // suppresses the spurious first delta. Steady-state deltas are exact.
  useEffect(() => {
    if (!liveRef.current) return;
    if (lastQueryKeyRef.current !== queryKeySerialized) {
      lastAnnouncedCount.current = 0;
      lastQueryKeyRef.current = queryKeySerialized;
    }
    if (captionCount === 0) return;
    const delta = captionCount - lastAnnouncedCount.current;
    if (delta > 0 && lastAnnouncedCount.current > 0) {
      liveRef.current.textContent = `Loaded ${delta} more ${delta === 1 ? "item" : "items"}. ${captionCount} of ${captionTotal} shown.`;
    }
    lastAnnouncedCount.current = captionCount;
  }, [captionCount, captionTotal, queryKeySerialized]);

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
            region above; this caption is plain text only. The count is
            the monotonic loaded-id accumulator, not the in-memory
            window length, so it never goes backwards when maxPages
            evicts the oldest page. */}
        {!isPending && !isError && rows.length > 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {`Showing ${captionCount.toLocaleString()} of ${captionTotal.toLocaleString()}`}
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

            {/* No "Load more" button — the IntersectionObserver
                sentinel inside VirtualScrollContainer drives
                pagination. Terminal line shows only once every page is
                loaded. */}
            {!hasNextPage ? (
              <div className="flex items-center justify-center pt-2">
                <p className="text-xs text-muted-foreground">
                  {`End of results — ${captionTotal.toLocaleString()} ${captionTotal === 1 ? "item" : "items"} shown`}
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
  fetchNextPage: () => Promise<unknown>;
}

/**
 * Virtualized scroll surface with variable-height rows and a real 1px
 * IntersectionObserver sentinel (rendered after the virtualizer
 * spacer) that triggers `fetchNextPage`.
 *
 * Uses `useWindowVirtualizer` so the page itself is the scroll surface
 * (window). The list reports its `offsetTop` as `scrollMargin` so the
 * virtualizer can translate virtual-item offsets back into the list
 * container's local coordinate space. The container has NO height
 * constraint and NO `overflow-auto` — it grows to the virtualizer's
 * total size and the document body scrolls.
 *
 * The sentinel is a normal-flow element after the spacer, not a
 * phantom virtual row, so it can never be evicted by `maxPages` and
 * is always last in DOM order. Its *viewport* position still depends
 * on the spacer height (`getTotalSize()`) being roughly correct under
 * variable-height `measureElement`; the 200px rootMargin + post-spacer
 * placement make it self-correcting on the next scroll/resize. A
 * synchronous ref latch plus the shared `isFetchingNextPage` flag
 * prevent in-container double-fire under React batching and fast
 * scrolling (see the effect body for cross-container dedupe).
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

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => estimateSize,
    overscan: 6,
    scrollMargin: listOffset,
    // measureElement allows variable-height rows; we attach it via ref below.
  });

  const virtualItems = virtualizer.getVirtualItems();

  // IntersectionObserver sentinel auto-fetch. The sentinel enters view
  // (200px rootMargin lookahead) as the user nears the end.
  //
  // Continuation: when the sentinel stays in view after a page settles
  // (tall viewport / short page) `inView` does NOT re-toggle — the
  // re-fire comes from `isFetchingNextPage` flipping true→false in the
  // dep array re-running this effect. Do not remove that dep.
  //
  // Double-fire: the per-container ref latch stops a re-fire within
  // THIS container. The desktop and mobile containers each have their
  // own latch and do not coordinate; cross-container single-flight
  // relies on (a) the CSS-hidden container's sentinel never
  // intersecting (display:none) and (b) TanStack's own in-flight
  // fetchNextPage de-dupe. Net effect is one network request.
  const { ref: sentinelRef, inView } = useInView({
    rootMargin: "200px 0px",
  });
  const fetchLatch = useRef(false);
  useEffect(() => {
    if (!inView || fetchLatch.current) return;
    if (!hasNextPage || isFetchingNextPage) return;
    fetchLatch.current = true;
    void Promise.resolve(fetchNextPage()).finally(() => {
      fetchLatch.current = false;
    });
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
        {virtualItems.map((virtualItem) => (
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
            {renderItem(rows[virtualItem.index] as T, virtualItem.index)}
          </div>
        ))}
      </div>
      {/* Real sentinel in normal flow after the spacer. Never evicted
          by maxPages; its position is always the true content end. */}
      {hasNextPage ? (
        <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
      ) : null}
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
