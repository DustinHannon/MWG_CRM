"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { StandardEmptyState } from "./standard-empty-state";
import { StandardLoadingState } from "./standard-loading-state";
import {
  StandardPageHeader,
  type StandardPageHeaderProps,
} from "./standard-page-header";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
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
 * Dual-slot shape for the `bulkActions` prop. Pages that need a
 * banner only (or a toolbar only) supply the relevant key; pages
 * that pre-date the dual-slot contract pass a plain `ReactNode`
 * which the shell treats as the banner slot for back-compat.
 */
export interface BulkActionsSlotObject {
  banner?: ReactNode;
  toolbar?: ReactNode;
}

export type BulkActionsSlot = BulkActionsSlotObject | ReactNode;

/** Type guard: the object-form vs the ReactNode-form. */
function isBulkActionsSlotObject(
  value: BulkActionsSlot,
): value is BulkActionsSlotObject {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  // Discriminate by presence of the named slots. A bare ReactElement
  // is also an object but lacks `banner` / `toolbar` props at the
  // top level, so this check correctly routes it through the
  // legacy ReactNode branch.
  if ("banner" in value || "toolbar" in value) {
    // A bare ReactElement does have a `type` prop, so further
    // narrow: object-form has NO `type` (or `props`) at the top
    // level. ReactElement has both. Practically: if either named
    // slot is present AND `type` / `props` are missing, treat as
    // object-form.
    const maybeElement = value as { type?: unknown; props?: unknown };
    if (maybeElement.type === undefined && maybeElement.props === undefined) {
      return true;
    }
  }
  return false;
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
   * Slot for bulk-selection toolbars / banners. Two-shape accepted:
   *
   *   - `{ banner?, toolbar? }` (preferred). The `banner` renders
   *     between the filter slot and the result list — typically a
   *     `<BulkSelectionBanner />`. The `toolbar` renders as a
   *     fixed-position overlay anchored to the viewport bottom —
   *     typically a `<BulkActionToolbar>`. The toolbar uses
   *     `position: fixed` so it does not move with the virtualized
   *     scroll surface.
   *   - `ReactNode` (legacy / back-compat). Treated as the banner
   *     slot. Older call sites that pre-date the dual-slot contract
   *     keep compiling.
   */
  bulkActions?: BulkActionsSlot;
  /** Page size hint forwarded to `fetchPage` callers via the Load-more label. Default 50. */
  pageSize?: number;
  /** Header props — forwarded to `<StandardPageHeader />`. */
  header: StandardPageHeaderProps;
  /** Optional filter bar rendered between the header and the result list. */
  filtersSlot?: ReactNode;
  className?: string;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Canonical list-page shell. Owns infinite scroll, virtualization,
 * scroll restoration, accessibility scaffolding (skip-links, ARIA live
 * region, reduced-motion fallback), and empty/loading/error states.
 *
 * Data-shape constraints:
 * `fetchPage` MUST return an opaque cursor string (or null when
 * exhausted) so the shell stays cursor-paginated independent of the
 * underlying SQL strategy.
 * `total` MAY be the page's running total or the overall result-set
 * total — the shell uses it only for the "Showing N of M" affordance.
 *
 * Reduced-motion behavior:
 * Auto-fetch via intersection sentinel is disabled when
 * `prefers-reduced-motion: reduce` is set. Users must click the
 * always-visible "Load more" button. The button is also always
 * rendered when there are more pages, regardless of the user's
 * motion preference — it's the keyboard- and screen-reader-friendly
 * path.
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
  pageSize = DEFAULT_PAGE_SIZE,
  header,
  filtersSlot,
  className,
}: StandardListPageProps<T, F>) {
  const reducedMotion = useReducedMotion();

  const query = useInfiniteQuery<StandardListPagePage<T>, Error>({
    queryKey: [...queryKey, filters],
    queryFn: ({ pageParam }) => fetchPage((pageParam as string | null) ?? null, filters),
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
  useEffect(() => {
    if (!liveRef.current) return;
    if (rows.length === 0) return;
    const delta = rows.length - lastAnnouncedCount.current;
    if (delta > 0 && lastAnnouncedCount.current > 0) {
      liveRef.current.textContent = `Loaded ${delta} more ${delta === 1 ? "item" : "items"}. ${rows.length} of ${total} shown.`;
    }
    lastAnnouncedCount.current = rows.length;
  }, [rows.length, total]);

  return (
    <div
      className={["space-y-3", className ?? ""].filter(Boolean).join(" ")}
    >
      {/* Skip-links: visible on focus only, follow Tab order. */}
      <a
        href="#list-filters"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-1.5 focus:text-sm focus:text-popover-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to filters
      </a>
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

      <div id="list-actions">
        <StandardPageHeader {...header} />
      </div>

      {filtersSlot ? <div id="list-filters">{filtersSlot}</div> : null}

      {(() => {
        if (!bulkActions) return null;
        if (isBulkActionsSlotObject(bulkActions)) {
          return bulkActions.banner ? <div>{bulkActions.banner}</div> : null;
        }
        return <div>{bulkActions}</div>;
      })()}

      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        ref={liveRef}
      />

      {/* Showing N of M affordance — rendered above the list, not inside
          the virtualized scroller. The dedicated live region above owns
          screen-reader announcements; this visible line is plain text so
          we don't double-announce on page loads. */}
      {!isPending && !isError && rows.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          {`Showing ${loadedCount.toLocaleString()} of ${total.toLocaleString()}`}
        </div>
      ) : null}

      <div id="list-results">
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
            {/* Desktop virtualized table. Hidden below md. */}
            <div className="hidden md:block">
              <VirtualScrollContainer
                rows={rows}
                renderItem={renderRow}
                estimateSize={rowEstimateSize}
                hasNextPage={Boolean(hasNextPage)}
                isFetchingNextPage={isFetchingNextPage}
                fetchNextPage={fetchNextPage}
                reducedMotion={reducedMotion}
                scope="desktop"
              />
            </div>

            {/* Mobile virtualized cards. Hidden md and up. */}
            <div className="md:hidden">
              <VirtualScrollContainer
                rows={rows}
                renderItem={renderCard}
                estimateSize={cardEstimateSize}
                hasNextPage={Boolean(hasNextPage)}
                isFetchingNextPage={isFetchingNextPage}
                fetchNextPage={fetchNextPage}
                reducedMotion={reducedMotion}
                scope="mobile"
              />
            </div>

            {/* Load-more button: always rendered when more pages exist.
                Sole trigger when reduced-motion is preferred. Keyboard
                + screen-reader friendly regardless. */}
            <div className="flex items-center justify-center pt-2">
              {hasNextPage ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!isFetchingNextPage) void fetchNextPage();
                  }}
                  disabled={isFetchingNextPage}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isFetchingNextPage
                    ? "Loading more"
                    : `Load ${Math.min(pageSize, Math.max(0, total - loadedCount)).toLocaleString()} more (${loadedCount.toLocaleString()} of ${total.toLocaleString()} shown)`}
                </button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {`End of results — ${total.toLocaleString()} ${total === 1 ? "item" : "items"} shown`}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Bulk action toolbar. Rendered last so it sits in stacking
          order above the scroll surface; visibility is owned by the
          toolbar component (renders null when selection scope is
          `none`). The toolbar itself uses `position: fixed` so it
          does not need to live inside the scroll container. */}
      {isBulkActionsSlotObject(bulkActions) && bulkActions.toolbar
        ? bulkActions.toolbar
        : null}
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
  reducedMotion: boolean;
  /** Storage scope so desktop and mobile scrollers don't collide. */
  scope: "desktop" | "mobile";
}

/**
 * Virtualized scroll surface with variable-height rows, an
 * intersection sentinel that triggers `fetchNextPage` (suppressed when
 * `reducedMotion` is true), and per-URL scroll restoration.
 *
 * The container itself owns the scrolling — Tailwind sets a fixed
 * viewport height (`h-[calc(100vh-220px)]`) so the virtualizer has a
 * scrollElement to measure against. The 220px subtracts approximate
 * heights of the topbar + page header + filters; pages can override
 * with their own outer wrapper when needed.
 */
function VirtualScrollContainer<T>({
  rows,
  renderItem,
  estimateSize,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  reducedMotion,
  scope,
}: VirtualScrollContainerProps<T>) {
  // TanStack Virtual returns functions that cannot be safely memoized;
  // opt this component out of the React Compiler to preserve correct
  // scroll measurements. See @tanstack/react-virtual docs on
  // `useVirtualizer` and React Compiler interop.
  "use no memo";
  const parentRef = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(parentRef, scope);

  // Count includes a trailing sentinel row when more pages exist.
  const count = hasNextPage ? rows.length + 1 : rows.length;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 6,
    // measureElement allows variable-height rows; we attach it via ref below.
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Sentinel-driven auto-fetch. Suppressed when reduced-motion is on.
  useEffect(() => {
    if (reducedMotion) return;
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
    reducedMotion,
  ]);

  return (
    <div
      ref={parentRef}
      role="feed"
      aria-busy={isFetchingNextPage}
      className="relative h-[calc(100vh-220px)] min-h-[400px] overflow-auto rounded-lg border border-border bg-card"
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
                transform: `translateY(${virtualItem.start}px)`,
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
