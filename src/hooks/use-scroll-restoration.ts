"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

const STORAGE_PREFIX = "mwg-list-scroll:";

/**
 * Persists and restores `window.scrollY` keyed by the current URL
 * (pathname + search params). On mount the window is restored to its
 * previous offset; on scroll and on page hide the offset is saved.
 *
 * The save key changes whenever the route or query string changes, so
 * each filter / sort / saved-view URL has its own restoration slot.
 * sessionStorage is used so the offset survives in-tab navigations
 * but does not persist across tabs or sessions.
 *
 * List pages use window-scoped scroll (the page itself is the scroll
 * surface — see CLAUDE.md "List page scroll behavior"). Earlier
 * versions of this hook accepted a container `RefObject` and read
 * `scrollTop` off it; that contract is no longer applicable.
 */
export function useScrollRestoration(
  /**
   * Optional discriminator appended to the storage key. Use this when
   * the same URL renders multiple list surfaces (e.g., desktop table
   * + mobile cards) and each needs its own offset, even though both
   * scroll the window.
   */
  scope?: string,
) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams ? searchParams.toString() : "";
  const key = `${STORAGE_PREFIX}${pathname ?? ""}?${search}${scope ? `#${scope}` : ""}`;

  // Combined restore + save lifecycle. Restoration runs first and
  // gates the save listener so we don't overwrite the saved key with
  // the intermediate (clamped) scrollY values while the document
  // height is still growing into the virtualized total size.
  useEffect(() => {
    if (typeof window === "undefined") return;

    let saved: number | null = null;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw !== null) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) saved = parsed;
      }
    } catch {
      // sessionStorage may be unavailable (private mode, cookies
      // blocked). The save listener will degrade similarly below.
    }

    let restorationDone = saved === null;
    let aborted = false;
    let pendingSave = false;

    const save = () => {
      pendingSave = false;
      // Don't overwrite the saved value while we're still trying to
      // restore — intermediate scrollY values during the document
      // growth window are 0 / clamped to the partial body height.
      if (!restorationDone) return;
      try {
        window.sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        // sessionStorage may be unavailable; ignore.
      }
    };

    const onScroll = () => {
      if (pendingSave) return;
      pendingSave = true;
      window.requestAnimationFrame(save);
    };
    const onPageHide = () => save();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);

    if (saved !== null) {
      // Poll until the document is tall enough to honor the target
      // scroll, capped at ~1 second so a genuinely shorter page (e.g.,
      // filters changed since) doesn't loop forever. Abort if the
      // user scrolls during the wait so we don't fight their input.
      const start = performance.now();
      const target = saved;
      let expectingProgrammatic = false;

      const onUserScrollDuringRestore = () => {
        if (expectingProgrammatic) {
          expectingProgrammatic = false;
          return;
        }
        aborted = true;
        restorationDone = true;
        window.removeEventListener("scroll", onUserScrollDuringRestore);
      };
      window.addEventListener("scroll", onUserScrollDuringRestore, {
        passive: true,
      });

      const tick = () => {
        if (aborted) return;
        const docHeight =
          document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight >= target || performance.now() - start > 1000) {
          expectingProgrammatic = true;
          window.scrollTo(0, target);
          window.requestAnimationFrame(() => {
            restorationDone = true;
            window.removeEventListener(
              "scroll",
              onUserScrollDuringRestore,
            );
          });
          return;
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    }

    return () => {
      aborted = true;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      // Capture once more on unmount so SPA navigations also persist
      // — but only if restoration completed; otherwise we'd save the
      // partial-height clamped value.
      if (restorationDone) save();
    };
  }, [key]);
}
