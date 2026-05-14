"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  AVAILABLE_TASK_COLUMNS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";
import { useClickOutside } from "@/hooks/use-click-outside";
import { setTaskAdhocColumnsAction } from "../view-actions";

/**
 * Column-chooser dropdown for the /tasks list. Mirrors the leads
 * and contacts ColumnChooser pattern. Toggling a column updates the
 * URL `?cols=` param (in-session source of truth) and — when the
 * active view is a built-in — persists the choice to
 * `user_preferences.adhocColumns.task` so a reload preserves it.
 *
 * Saved views own their own column list on the saved_views row; for
 * those, the user updates persistence via the toolbar's "Save
 * changes" button rather than auto-persisting on every toggle.
 */
export function TaskColumnsMenu({
  activeColumns,
  activeViewId,
  baseColumns,
}: {
  activeColumns: TaskColumnKey[];
  activeViewId: string;
  baseColumns: TaskColumnKey[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(containerRef, () => setOpen(false), open);

  function toggle(key: TaskColumnKey) {
    const next = activeColumns.includes(key)
      ? activeColumns.filter((c) => c !== key)
      : [...activeColumns, key];
    // Never let the user remove every column — the table needs at
    // least one to render meaningfully.
    if (next.length === 0) return;

    const params = new URLSearchParams(search.toString());
    params.set("cols", next.join(","));
    router.push(`/tasks?${params.toString()}`);

    // Auto-persist adhoc selection when a built-in view is active.
    // Saved-view persistence is handled via the toolbar Save action.
    if (activeViewId.startsWith("builtin:")) {
      const columnsForPersist =
        next.length === baseColumns.length &&
        next.every((c, i) => baseColumns[i] === c)
          ? null
          : next;
      void setTaskAdhocColumnsAction({ columns: columnsForPersist });
    }
  }

  function reset() {
    const params = new URLSearchParams(search.toString());
    params.delete("cols");
    router.push(`/tasks?${params.toString()}`);
    if (activeViewId.startsWith("builtin:")) {
      void setTaskAdhocColumnsAction({ columns: null });
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted"
      >
        Columns ({activeColumns.length})
      </button>
      {open ? (
        <>
          <div className="absolute right-0 top-full z-50 mt-1 max-h-96 w-72 overflow-y-auto rounded-md border border-border bg-[var(--popover)] p-2 text-[var(--popover-foreground)] shadow-2xl">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                Show columns
              </span>
              <button
                type="button"
                onClick={reset}
                className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                Reset
              </button>
            </div>
            {AVAILABLE_TASK_COLUMNS.map((c) => (
              <label
                key={c.key}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={activeColumns.includes(c.key)}
                  onChange={() => toggle(c.key)}
                  className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
