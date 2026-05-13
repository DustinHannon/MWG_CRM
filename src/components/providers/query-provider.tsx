"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * Mounts a singleton TanStack Query client inside the React tree so
 * client-side `useInfiniteQuery` / `useQuery` consumers (the canonical
 * list-page shell and any future client-side data fetcher) share a
 * single cache + dedup boundary per browser tab.
 *
 * Defaults are tuned for the list-page workload: 30s freshness so a
 * filter tweak that re-issues an identical query returns instantly
 * from cache, no window-focus refetch (Realtime + manual reload are
 * the freshness mechanisms in this codebase), retry once on transient
 * failure.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
