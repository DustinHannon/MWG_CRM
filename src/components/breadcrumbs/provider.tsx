"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Breadcrumb } from "./types";

interface Ctx {
  crumbs: Breadcrumb[];
  setCrumbs: (c: Breadcrumb[]) => void;
}

const BreadcrumbsCtx = createContext<Ctx | null>(null);

/**
 * Phase 11 — Breadcrumbs context. Lives once per shell. Pages call
 * `useSetBreadcrumbs([...])` from their client subtree to register a
 * trail; the trail unregisters on unmount so the next page starts
 * blank.
 */
export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<Breadcrumb[]>([]);
  const value = useMemo(() => ({ crumbs, setCrumbs }), [crumbs]);
  return (
    <BreadcrumbsCtx.Provider value={value}>{children}</BreadcrumbsCtx.Provider>
  );
}

/**
 * Register a breadcrumb trail for the current page. Call from a client
 * component at the top of the page subtree. Pass `loading: true` on
 * any segment whose label depends on a still-fetching query.
 *
 * The serialised dependency array keeps the effect stable: passing a
 * fresh array literal each render won't loop the registration.
 */
export function useSetBreadcrumbs(crumbs: Breadcrumb[]): void {
  const ctx = useContext(BreadcrumbsCtx);
  const key = JSON.stringify(crumbs);
  const setCrumbs = ctx?.setCrumbs;
  useEffect(() => {
    if (!setCrumbs) return;
    setCrumbs(crumbs);
    return () => setCrumbs([]);
    // crumbs is stable-by-value via JSON.stringify; setCrumbs is stable
    // because the provider memos it. Suppressing exhaustive-deps is
    // the same pattern used elsewhere in the codebase for serialized
    // dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setCrumbs]);
}

export function useBreadcrumbs(): Breadcrumb[] {
  return useContext(BreadcrumbsCtx)?.crumbs ?? [];
}

