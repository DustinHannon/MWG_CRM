"use client";

import { useEffect, useRef } from "react";

/**
 * Phase 11 — wraps a list-row container and animates a one-shot amber
 * flash when a row id is freshly added to the rendered set.
 *
 * Usage:
 *   <tbody>
 *     {rows.map((r) => (
 *       <RowFlashRow key={r.id} rowId={r.id} as="tr" {...}>
 *         <td>{r.name}</td>...
 *       </RowFlashRow>
 *     ))}
 *   </tbody>
 *
 * The first render after mount is treated as "initial state" — no flash
 * fires for the existing rows, only for ids that appear later (after a
 * router.refresh() driven by useRealtimePoll).
 */

const SEEN_KEY = "mwg-rowflash-seen";

interface SeenStore {
  ids: Map<string, number>; // id → timestamp last seen
  initialized: boolean;
}

function getSeenStore(): SeenStore {
  if (typeof window === "undefined") {
    return { ids: new Map(), initialized: true };
  }
  type WindowWithStore = Window & { __mwgRowFlashSeen?: SeenStore };
  const w = window as WindowWithStore;
  if (!w.__mwgRowFlashSeen) {
    w.__mwgRowFlashSeen = { ids: new Map(), initialized: false };
  }
  return w.__mwgRowFlashSeen;
}

interface RowFlashRowProps {
  rowId: string;
  /** Tag to render. Default: "tr". */
  as?: "tr" | "div" | "li";
  className?: string;
  children: React.ReactNode;
  /** Optional CSS color string. Stamps `--row-accent-color` so the row
   *  shows a 3px left-edge accent stripe. */
  accentColor?: string;
}

export function RowFlashRow({
  rowId,
  as = "tr",
  className,
  children,
  accentColor,
}: RowFlashRowProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const store = getSeenStore();
    if (!store.initialized) {
      // First mount in this tab — seed the seen-set with currently-rendered
      // ids so we don't flash everything on initial page load.
      // The seeding happens in the SeedSeenIds effect below at the
      // wrapper level. Nothing to do here on first init.
    }
    const isNew = !store.ids.has(rowId);
    store.ids.set(rowId, Date.now());
    if (isNew && store.initialized) {
      node.setAttribute("data-row-flash", "new");
      const onEnd = () => node.removeAttribute("data-row-flash");
      node.addEventListener("animationend", onEnd, { once: true });
      return () => node.removeEventListener("animationend", onEnd);
    }
    return () => {
      // intentionally don't drop the seen entry — keep the page-life
      // memory so a refresh doesn't re-flash the same rows.
    };
  }, [rowId]);

  const Tag = as as React.ElementType;
  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        ref.current = el;
      }}
      data-row-id={rowId}
      data-row-accent={accentColor ? "1" : undefined}
      style={
        accentColor
          ? ({ "--row-accent-color": accentColor } as React.CSSProperties)
          : undefined
      }
      className={className}
    >
      {children}
    </Tag>
  );
}

/**
 * Mounts once at the top of any list view. Marks the row-flash store
 * as initialized AFTER the first paint so the initial set of rendered
 * row ids gets recorded as "seen" without animating.
 */
export function RowFlashRoot({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const store = getSeenStore();
    // Defer init by one frame so the initial RowFlashRow effects can
    // populate the seen-set before any future row is treated as new.
    const id = window.requestAnimationFrame(() => {
      store.initialized = true;
    });
    return () => window.cancelAnimationFrame(id);
  }, []);
  return <>{children}</>;
}
