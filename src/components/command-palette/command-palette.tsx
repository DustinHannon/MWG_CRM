"use client";

import { Command } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  CheckSquare,
  FileText,
  Folder,
  Search,
  Settings,
  Tag,
  Trophy,
  User,
} from "lucide-react";

interface RecentItem {
  entityType: string;
  entityId: string;
  label: string;
  sublabel: string | null;
  link: string;
}

interface SearchHit {
  type: "lead" | "contact" | "account" | "opportunity" | "task" | "tag";
  id: string;
  label: string;
  sublabel: string | null;
  link: string;
}

const QUICK_ACTIONS = [
  { id: "new-lead", label: "Add lead", link: "/leads/new", icon: User },
  { id: "import", label: "Import leads", link: "/leads/import", icon: FileText },
  { id: "tasks", label: "Open tasks", link: "/tasks", icon: CheckSquare },
  { id: "settings", label: "Settings", link: "/settings", icon: Settings },
];

const TYPE_ICONS = {
  lead: User,
  contact: User,
  account: Building2,
  opportunity: Trophy,
  task: Folder,
  tag: Tag,
} as const;

/**
 * Cmd+K palette mounted at the app shell. Shows quick
 * actions + recent records when query is empty; cross-entity search
 * results when query is non-empty.
 */
export function CommandPalette({ recent }: { recent: RecentItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchError, setSearchError] = useState(false);
  const [searching, setSearching] = useState(false);
  const router = useRouter();
  const debounceRef = useRef<number | null>(null);

  // Radix Dialog (via cmdk's Command.Dialog) owns focus trap, focus
  // restoration, Escape-to-close, body scroll lock, and outside-click —
  // no manual key/scroll effects needed here.

  // Global shortcut.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Click-driven open from a visible affordance (top-bar Search button).
  useEffect(() => {
    function open() {
      setOpen(true);
    }
    window.addEventListener("mwg:command-palette-open", open);
    return () => window.removeEventListener("mwg:command-palette-open", open);
  }, []);

  // Debounced search. Each run owns an AbortController so a superseded
  // fetch is cancelled on cleanup; the `controller.signal.aborted` guard
  // before setHits prevents a slow earlier response ('ab') from
  // overwriting a newer one ('abc') if it resolves after the abort.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (query.trim().length === 0) {
      debounceRef.current = window.setTimeout(() => {
        setHits([]);
        setSearching(false);
        setSearchError(false);
      }, 0);
      return;
    }
    const controller = new AbortController();
    debounceRef.current = window.setTimeout(async () => {
      // Flip to the searching state when the debounced request actually
      // starts — not synchronously in the effect body, which trips the
      // set-state-in-effect cascade lint (and would flash the spinner
      // during the debounce window).
      setSearching(true);
      setSearchError(false);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!res.ok) {
          if (!controller.signal.aborted) {
            setHits([]);
            setSearchError(true);
            setSearching(false);
          }
          return;
        }
        const data = (await res.json()) as { hits: SearchHit[] };
        if (!controller.signal.aborted) {
          setHits(data.hits);
          setSearchError(false);
          setSearching(false);
        }
      } catch {
        // AbortError from a superseded run is expected; only surface a
        // failure for a genuine error of the still-current request.
        if (!controller.signal.aborted) {
          setHits([]);
          setSearchError(true);
          setSearching(false);
        }
      }
    }, 200);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [query]);

  function go(link: string) {
    setOpen(false);
    setQuery("");
    router.push(link);
  }

  const grouped: Record<SearchHit["type"], SearchHit[]> = {
    lead: [],
    contact: [],
    account: [],
    opportunity: [],
    task: [],
    tag: [],
  };
  for (const h of hits) grouped[h.type].push(h);

  // cmdk's Command.Dialog renders the command tree inside a Radix
  // Dialog, which provides the focus trap, focus restoration,
  // Escape-to-close, body scroll lock, outside-click, and portal —
  // replacing the former hand-rolled scrim + manual key/scroll
  // effects. Radix portals the overlay/content as direct body
  // children; body uses `isolation: isolate` (globals.css) so a
  // fixed-position overlay anchors to the viewport without a wrapper.
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-[60] bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      contentClassName="glass-surface glass-surface--3 fixed left-1/2 top-[12vh] z-[60] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    >
          <div className="flex items-center gap-3 border-b border-glass-border px-4">
            <Search size={16} className="text-muted-foreground" aria-hidden />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search leads, contacts, accounts, opportunities, tasks…"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              autoFocus
            />
            <span className="text-[10px] text-muted-foreground">Esc</span>
          </div>

          <Command.List className="max-h-[400px] overflow-y-auto p-2">
            {query.length === 0 ? (
              <>
                <Command.Group
                  heading="Quick actions"
                  className="text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {QUICK_ACTIONS.map((a) => {
                    const Icon = a.icon;
                    return (
                      <Command.Item
                        key={a.id}
                        onSelect={() => go(a.link)}
                        className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm aria-selected:bg-accent/50"
                      >
                        <Icon size={14} aria-hidden />
                        {a.label}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
                {recent.length > 0 ? (
                  <Command.Group
                    heading="Recent"
                    className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground"
                  >
                    {recent.map((r) => {
                      const Icon =
                        TYPE_ICONS[r.entityType as keyof typeof TYPE_ICONS] ?? User;
                      return (
                        <Command.Item
                          key={`${r.entityType}-${r.entityId}`}
                          onSelect={() => go(r.link)}
                          className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm aria-selected:bg-accent/50"
                        >
                          <Icon size={14} aria-hidden />
                          <div className="flex-1">
                            <p className="truncate">{r.label}</p>
                            {r.sublabel ? (
                              <p className="text-xs text-muted-foreground">
                                {r.sublabel}
                              </p>
                            ) : null}
                          </div>
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {r.entityType}
                          </span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}
              </>
            ) : (
              <>
                {hits.length === 0 ? (
                  searching ? (
                    <p className="p-6 text-center text-xs text-muted-foreground">
                      Searching…
                    </p>
                  ) : searchError ? (
                    <p className="p-6 text-center text-xs text-muted-foreground">
                      Search is unavailable. Try again.
                    </p>
                  ) : (
                    <p className="p-6 text-center text-xs text-muted-foreground">
                      No matches.
                    </p>
                  )
                ) : null}
                {(["lead", "contact", "account", "opportunity", "task", "tag"] as const).map(
                  (type) =>
                    grouped[type].length > 0 ? (
                      <Command.Group
                        key={type}
                        heading={`${type[0].toUpperCase()}${type.slice(1)}s`}
                        className="text-[10px] uppercase tracking-wide text-muted-foreground"
                      >
                        {grouped[type].map((h) => {
                          const Icon = TYPE_ICONS[h.type];
                          return (
                            <Command.Item
                              key={`${h.type}-${h.id}`}
                              onSelect={() => go(h.link)}
                              className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm aria-selected:bg-accent/50"
                            >
                              <Icon size={14} aria-hidden />
                              <div className="flex-1">
                                <p className="truncate">{h.label}</p>
                                {h.sublabel ? (
                                  <p className="text-xs text-muted-foreground">
                                    {h.sublabel}
                                  </p>
                                ) : null}
                              </div>
                            </Command.Item>
                          );
                        })}
                      </Command.Group>
                    ) : null,
                )}
              </>
            )}
          </Command.List>

          <div className="border-t border-glass-border px-3 py-1.5 text-[10px] text-muted-foreground">
            <kbd className="rounded bg-input/60 px-1.5 py-0.5">⌘K</kbd> to open ·{" "}
            <kbd className="rounded bg-input/60 px-1.5 py-0.5">Enter</kbd> to go
          </div>
    </Command.Dialog>
  );
}
