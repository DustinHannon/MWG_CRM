"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { AVAILABLE_COLUMNS, type ColumnKey } from "@/lib/view-constants";
import {
  createViewAction,
  deleteViewAction,
  setAdhocColumnsAction,
  trackViewSelection,
  updateViewAction,
} from "./view-actions";

export interface ViewSummary {
  id: string;
  name: string;
  source: "builtin" | "saved";
  scope: "mine" | "all";
  isPinned?: boolean;
}

export interface ViewToolbarProps {
  views: ViewSummary[];
  activeViewId: string;
  activeColumns: ColumnKey[];
  baseColumns: ColumnKey[];
  /** "saved:<uuid>" if active view is saved AND user has dirty state, else null. */
  savedDirtyId: string | null;
  /** True when activeColumns differs from baseColumns. */
  columnsModified: boolean;
}

/**
 * Top-of-page toolbar:
 * - View selector (built-in + saved)
 * - "Modified" badge with Save changes / Save as new
 * - Column chooser
 *
 * Filter inputs live in the existing form below the toolbar — those are
 * server-rendered and submit via GET so the URL stays the source of truth
 * for filter state. Columns are passed as &cols=a,b,c.
 */
export function ViewToolbar({
  views,
  activeViewId,
  activeColumns,
  baseColumns,
  savedDirtyId,
  columnsModified,
}: ViewToolbarProps) {
  const router = useRouter();
  const search = useSearchParams();
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [, startTransition] = useTransition();

  const grouped = useMemo(() => {
    return {
      builtin: views.filter((v) => v.source === "builtin"),
      saved: views.filter((v) => v.source === "saved"),
    };
  }, [views]);

  const onPickView = (id: string) => {
    const params = new URLSearchParams(search.toString());
    params.set("view", id);
    // Clear filter params when switching views — the new view brings its
    // own filter base.
    for (const k of ["q", "status", "rating", "source", "tag", "cols", "sort", "dir", "page"]) {
      params.delete(k);
    }
    startTransition(() => {
      router.push(`/leads?${params.toString()}`);
      // Persist last-used asynchronously; non-blocking.
      void trackViewSelection(id);
    });
  };

  const onToggleColumn = async (key: ColumnKey) => {
    const next = activeColumns.includes(key)
      ? activeColumns.filter((c) => c !== key)
      : [...activeColumns, key];
    if (next.length === 0) return; // refuse to clear all columns
    const params = new URLSearchParams(search.toString());
    params.set("cols", next.join(","));
    router.push(`/leads?${params.toString()}`);

    // Persist as adhoc when on a built-in view; saved-view divergence is
    // tracked by the URL alone and surfaces the "Modified" badge.
    if (activeViewId.startsWith("builtin:")) {
      const fd = new FormData();
      fd.set(
        "payload",
        JSON.stringify({ columns: next.length === baseColumns.length ? null : next }),
      );
      void setAdhocColumnsAction(fd);
    }
  };

  const onResetColumns = () => {
    const params = new URLSearchParams(search.toString());
    params.delete("cols");
    router.push(`/leads?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* View selector */}
      <ViewSelectMenu
        grouped={grouped}
        activeViewId={activeViewId}
        onPick={onPickView}
      />

      {/* Modified badge + actions */}
      {columnsModified ? (
        <span className="rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
          Modified
        </span>
      ) : null}

      {savedDirtyId && columnsModified ? (
        <button
          type="button"
          onClick={() => {
            const id = savedDirtyId.slice("saved:".length);
            const fd = new FormData();
            fd.set("id", id);
            fd.set("payload", JSON.stringify({ columns: activeColumns }));
            startTransition(async () => {
              await updateViewAction(fd);
              router.refresh();
            });
          }}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
        >
          Save changes
        </button>
      ) : null}

      {columnsModified ? (
        <button
          type="button"
          onClick={() => setSaveOpen(true)}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
        >
          Save as new view
        </button>
      ) : null}

      {/* Column chooser */}
      <div className="relative ml-auto">
        <button
          type="button"
          onClick={() => setColumnsOpen((o) => !o)}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
        >
          Columns ({activeColumns.length})
        </button>
        {columnsOpen ? (
          <ColumnChooser
            active={activeColumns}
            onToggle={onToggleColumn}
            onClose={() => setColumnsOpen(false)}
            onReset={onResetColumns}
          />
        ) : null}
      </div>

      {saveOpen ? (
        <SaveViewDialog
          defaultColumns={activeColumns}
          activeViewId={activeViewId}
          search={search.toString()}
          onClose={() => setSaveOpen(false)}
          onSaved={(id) => {
            setSaveOpen(false);
            // Switch to the new saved view immediately.
            const params = new URLSearchParams(search.toString());
            params.set("view", id);
            params.delete("cols");
            startTransition(() => {
              router.push(`/leads?${params.toString()}`);
            });
          }}
        />
      ) : null}

      {/* Saved-view delete affordance */}
      {activeViewId.startsWith("saved:") ? (
        <button
          type="button"
          onClick={() => {
            if (!confirm("Delete this saved view? This cannot be undone.")) return;
            const id = activeViewId.slice("saved:".length);
            const fd = new FormData();
            fd.set("id", id);
            startTransition(async () => {
              await deleteViewAction(fd);
              router.push("/leads?view=builtin:my-open");
            });
          }}
          className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-100 transition hover:bg-rose-500/20"
        >
          Delete view
        </button>
      ) : null}
    </div>
  );
}

function ViewSelectMenu({
  grouped,
  activeViewId,
  onPick,
}: {
  grouped: { builtin: ViewSummary[]; saved: ViewSummary[] };
  activeViewId: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = [...grouped.builtin, ...grouped.saved].find(
    (v) => v.id === activeViewId,
  );
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white transition hover:bg-white/10"
      >
        <span className="font-medium">{active?.name ?? "Pick a view"}</span>
        <span className="text-white/40">▾</span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-white/10 bg-[var(--popover)] text-[var(--popover-foreground)] shadow-2xl">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-white/40">
              Built-in
            </div>
            {grouped.builtin.map((v) => (
              <ViewMenuItem
                key={v.id}
                view={v}
                active={v.id === activeViewId}
                onPick={() => {
                  setOpen(false);
                  onPick(v.id);
                }}
              />
            ))}
            {grouped.saved.length > 0 ? (
              <>
                <div className="mt-2 border-t border-white/10 px-3 py-2 text-[10px] uppercase tracking-wide text-white/40">
                  Saved
                </div>
                {grouped.saved.map((v) => (
                  <ViewMenuItem
                    key={v.id}
                    view={v}
                    active={v.id === activeViewId}
                    onPick={() => {
                      setOpen(false);
                      onPick(v.id);
                    }}
                  />
                ))}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ViewMenuItem({
  view,
  active,
  onPick,
}: {
  view: ViewSummary;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-white/5 ${active ? "bg-white/10 font-medium" : ""}`}
    >
      <span className="flex items-center gap-2">
        {view.isPinned ? <span aria-hidden>⭐</span> : null}
        {view.name}
      </span>
      {active ? <span aria-hidden>✓</span> : null}
    </button>
  );
}

function ColumnChooser({
  active,
  onToggle,
  onClose,
  onReset,
}: {
  active: ColumnKey[];
  onToggle: (key: ColumnKey) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close column chooser"
        className="fixed inset-0 z-40 cursor-default"
      />
      <div className="absolute right-0 top-full z-50 mt-1 max-h-96 w-72 overflow-y-auto rounded-md border border-white/10 bg-[var(--popover)] text-[var(--popover-foreground)] p-2 shadow-2xl">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[10px] uppercase tracking-wide text-white/40">
            Show columns
          </span>
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] uppercase tracking-wide text-white/60 hover:text-white"
          >
            Reset
          </button>
        </div>
        {AVAILABLE_COLUMNS.map((c) => (
          <label
            key={c.key}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-white/5"
          >
            <input
              type="checkbox"
              checked={active.includes(c.key)}
              onChange={() => onToggle(c.key)}
              className="h-4 w-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500"
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function SaveViewDialog({
  defaultColumns,
  activeViewId,
  search,
  onClose,
  onSaved,
}: {
  defaultColumns: ColumnKey[];
  activeViewId: string;
  search: string;
  onClose: () => void;
  onSaved: (newId: string) => void;
}) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);

    // Derive filters from URL params + the active view base. Server will
    // store the URL-state shape — keep it simple here.
    const params = new URLSearchParams(search);
    const filters: Record<string, unknown> = {};
    if (params.get("q")) filters.search = params.get("q");
    if (params.get("status")) filters.status = [params.get("status")];
    if (params.get("rating")) filters.rating = [params.get("rating")];
    if (params.get("source")) filters.source = [params.get("source")];
    if (params.get("tag")) filters.tags = [params.get("tag")];

    const payload = {
      name: name.trim(),
      isPinned: pin,
      scope: activeViewId.includes("all") ? "all" : "mine",
      filters,
      columns: defaultColumns,
      sort: { field: "lastActivityAt", direction: "desc" },
    };
    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));
    const res = await createViewAction(fd);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed.");
      return;
    }
    if (res.id) onSaved(`saved:${res.id}`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--popover)] text-[var(--popover-foreground)] p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Save current view</h2>
        <p className="mt-1 text-sm text-white/60">
          Captures your current filters and columns so you can come back to
          them with one click.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block text-xs uppercase tracking-wide text-white/50">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
              placeholder="e.g. East-coast hot leads"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pin}
              onChange={(e) => setPin(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500"
            />
            <span>Pin to top of list</span>
          </label>
          {error ? (
            <p className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-white/60 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-white/90 px-4 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Save view"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Re-export Link in case the toolbar grows (keeps tree-shaking happy).
export { Link };
