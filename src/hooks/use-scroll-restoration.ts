"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, type RefObject } from "react";

const STORAGE_PREFIX = "mwg-list-scroll:";

/**
 * Persists and restores the `scrollTop` of a scroll container keyed by
 * the current URL (pathname + search params). On mount the container
 * is restored to its previous offset; on scroll and on page hide the
 * offset is saved.
 *
 * The save key changes whenever the route or query string changes, so
 * each filter / sort / saved-view URL has its own restoration slot.
 * sessionStorage is used so the offset survives in-tab navigations
 * but does not persist across tabs or sessions.
 */
export function useScrollRestoration(
  containerRef: RefObject<HTMLElement | null>,
  /**
   * Optional discriminator appended to the storage key. Use this when
   * the same URL renders multiple scrollable surfaces (e.g., desktop
   * table + mobile cards) and each needs its own offset.
   */
  scope?: string,
) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams ? searchParams.toString() : "";
  const key = `${STORAGE_PREFIX}${pathname ?? ""}?${search}${scope ? `#${scope}` : ""}`;

  // Restore on mount or whenever the key changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const node = containerRef.current;
    if (!node) return;
    try {
      const saved = window.sessionStorage.getItem(key);
      if (saved !== null) {
        const offset = Number.parseInt(saved, 10);
        if (Number.isFinite(offset) && offset >= 0) {
          // Defer one frame so the virtualizer can lay out before we scroll.
          window.requestAnimationFrame(() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = offset;
            }
          });
        }
      }
    } catch {
      // sessionStorage may be unavailable (private mode, cookies blocked).
    }
  }, [key, containerRef]);

  // Save on scroll (rAF-throttled) and on page hide.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const node = containerRef.current;
    if (!node) return;

    let pending = false;
    const save = () => {
      pending = false;
      try {
        window.sessionStorage.setItem(key, String(node.scrollTop));
      } catch {
        // sessionStorage may be unavailable; ignore.
      }
    };
    const onScroll = () => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(save);
    };
    const onPageHide = () => save();

    node.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    return () => {
      node.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      // Capture once more on unmount so SPA navigations also persist.
      save();
    };
  }, [key, containerRef]);
}
