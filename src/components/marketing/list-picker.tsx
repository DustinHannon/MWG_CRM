"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Phase 21 — Marketing list picker.
 *
 * Used by the leads bulk-action surface and (future) campaign composer
 * to pick a list. Fetches from `/api/v1/marketing/lists?search=` with
 * a 250ms debounce; selecting a row calls `onSelect`.
 */
interface Props {
  trigger: ReactNode;
  onSelect: (listId: string, listName: string) => void;
}

interface ListSummary {
  id: string;
  name: string;
  memberCount: number;
}

export function ListPicker({ trigger, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ListSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchLists = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        "/api/v1/marketing/lists",
        window.location.origin,
      );
      if (q) url.searchParams.set("search", q);
      url.searchParams.set("pageSize", "20");
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: ListSummary[] };
      setResults(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(
        err instanceof Error ? err.message : "Failed to load lists.",
      );
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      void fetchLists(search);
    }, 250);
    return () => clearTimeout(handle);
  }, [open, search, fetchLists]);

  function handleSelect(item: ListSummary) {
    onSelect(item.id, item.name);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 rounded-lg border border-border bg-background p-2 shadow-xl"
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search lists…"
            className="h-9 w-full rounded-md border border-border bg-muted/30 pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <div className="mt-2 max-h-64 overflow-y-auto">
          {loading ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              Loading…
            </p>
          ) : error ? (
            <p className="px-3 py-4 text-center text-xs text-destructive">
              {error}
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No lists found.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(r)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted"
                  >
                    <span className="truncate font-medium">{r.name}</span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {r.memberCount.toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
