"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  }
  // Legacy fallback for older browsers without addEventListener on MediaQueryList.
  mql.addListener(callback);
  return () => mql.removeListener(callback);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Reads the user's `prefers-reduced-motion` media query and returns a
 * boolean that callers can use to suppress animations or auto-fetch
 * behavior. SSR-safe via `useSyncExternalStore` — returns `false`
 * during server render, then hydrates to the actual value.
 *
 * Use this when a UI surface drives motion or auto-triggered behavior
 * that a motion-sensitive viewer would want to suppress (auto-paging
 * via intersection observer, scroll-jump transitions, skeleton fades).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
