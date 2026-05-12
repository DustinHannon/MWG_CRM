"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  TaskViewDefinition,
  TaskViewFilters,
  TaskViewSort,
} from "@/lib/task-views";
import {
  createTaskViewAction,
  deleteTaskViewAction,
} from "../view-actions";

/**
 * Tasks view selector (parity-light version of the
 * leads ViewToolbar). Renders the built-in views + per-user saved
 * views as a dropdown; "Save current as view" persists the current
 * URL-state filters/sort as a new saved view. Active saved views
 * get a "Delete" affordance inline.
 */
export function TaskViewSelector({
  activeViewId,
  builtinViews,
  savedViews,
  currentFilters,
  currentSort,
}: {
  activeViewId: string;
  builtinViews: TaskViewDefinition[];
  savedViews: TaskViewDefinition[];
  currentFilters: TaskViewFilters;
  currentSort: TaskViewSort;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, startSaving] = useTransition();
  const all = [...builtinViews, ...savedViews];
  const active = all.find((v) => v.id === activeViewId) ?? builtinViews[0];

  function pick(id: string) {
    setOpen(false);
    router.push(`/tasks?view=${encodeURIComponent(id)}`);
  }

  function saveAs() {
    const name = window.prompt("Name this view:");
    if (!name || !name.trim()) return;
    startSaving(async () => {
      const res = await createTaskViewAction({
        name: name.trim(),
        isPinned: false,
        filters: currentFilters,
        sort: currentSort,
      });
      if (res.ok) {
        toast.success(`Saved "${name.trim()}"`);
        router.push(`/tasks?view=saved:${res.data.id}`);
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function deleteActive() {
    if (!activeViewId.startsWith("saved:")) return;
    if (!confirm(`Delete the saved view "${active?.name ?? "Untitled"}"?`)) {
      return;
    }
    const id = activeViewId.slice("saved:".length);
    startSaving(async () => {
      const res = await deleteTaskViewAction(id);
      if (res.ok) {
        toast.success("View deleted");
        router.push("/tasks");
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm hover:bg-muted"
        >
          <span className="font-medium">{active?.name ?? "Pick a view"}</span>
          <span className="text-muted-foreground/80">▾</span>
        </button>
        {open ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-[var(--popover)] text-[var(--popover-foreground)] shadow-2xl">
              <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                Built-in
              </div>
              <ul>
                {builtinViews.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => pick(v.id)}
                      className={
                        v.id === activeViewId
                          ? "w-full px-3 py-1.5 text-left text-sm text-primary"
                          : "w-full px-3 py-1.5 text-left text-sm hover:bg-accent/40"
                      }
                    >
                      {v.name}
                    </button>
                  </li>
                ))}
              </ul>
              {savedViews.length > 0 ? (
                <>
                  <div className="border-t border-border px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                    My saved
                  </div>
                  <ul>
                    {savedViews.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => pick(v.id)}
                          className={
                            v.id === activeViewId
                              ? "w-full px-3 py-1.5 text-left text-sm text-primary"
                              : "w-full px-3 py-1.5 text-left text-sm hover:bg-accent/40"
                          }
                        >
                          {v.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <button
        type="button"
        onClick={saveAs}
        disabled={saving}
        className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
      >
        {saving ? "Saving…" : "Save current as view"}
      </button>

      {activeViewId.startsWith("saved:") ? (
        <button
          type="button"
          onClick={deleteActive}
          disabled={saving}
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
        >
          Delete view
        </button>
      ) : null}
    </div>
  );
}
