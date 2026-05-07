"use client";

import { Command } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FileText, Folder, Search, Tag, Trophy, User } from "lucide-react";

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
  { id: "tasks", label: "Open tasks", link: "/tasks", icon: Folder },
  { id: "settings", label: "Settings", link: "/settings", icon: Folder },
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
 * Phase 3I — Cmd+K palette mounted at the app shell. Shows quick
 * actions + recent records when query is empty; cross-entity search
 * results when query is non-empty.
 */
export function CommandPalette({ recent }: { recent: RecentItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const router = useRouter();
  const debounceRef = useRef<number | null>(null);

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

  // Debounced search.
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (query.trim().length === 0) {
      debounceRef.current = window.setTimeout(() => setHits([]), 0);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          setHits([]);
          return;
        }
        const data = (await res.json()) as { hits: SearchHit[] };
        setHits(data.hits);
      } catch {
        setHits([]);
      }
    }, 200);
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-surface glass-surface--3 w-full max-w-xl overflow-hidden rounded-xl shadow-2xl"
      >
        <Command label="Command palette" shouldFilter={false}>
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
                  <p className="p-6 text-center text-xs text-muted-foreground">
                    No matches.
                  </p>
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
        </Command>
      </div>
    </div>
  );
}
