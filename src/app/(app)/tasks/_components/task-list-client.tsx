"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  createTaskAction,
  deleteTaskAction,
  toggleTaskCompleteAction,
} from "../actions";
import type { TaskRow } from "@/lib/tasks";
import {
  formatUserTime,
  type TimePrefs,
} from "@/lib/format-time";

interface TaskListClientProps {
  buckets: { label: string; tasks: TaskRow[] }[];
  userId: string;
  prefs: TimePrefs;
}

export function TaskListClient({ buckets, prefs }: TaskListClientProps) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  // Phase 6B — local version map updated optimistically and rolled
  // back on conflict, so subsequent toggles use the latest known
  // version after each successful save.
  const [versions, setVersions] = useState<Record<string, number>>({});

  function toggle(id: string, version: number, completed: boolean) {
    setOptimistic((o) => ({ ...o, [id]: completed }));
    startTransition(async () => {
      const res = await toggleTaskCompleteAction(id, version, completed);
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
        setOptimistic((o) => ({ ...o, [id]: !completed }));
      } else {
        setVersions((m) => ({ ...m, [id]: res.data.version }));
      }
    });
  }

  function remove(id: string) {
    if (!confirm("Delete this task?")) return;
    startTransition(async () => {
      const res = await deleteTaskAction(id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Task deleted");
    });
  }

  return (
    <div>
      <InlineCreate disabled={pending} />

      {buckets.length === 0 ? (
        <p className="mt-6 py-12 text-center text-sm text-muted-foreground">
          No open tasks. Add one above.
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {buckets.map((b) => (
            <div key={b.label}>
              <p
                className={
                  "text-[10px] uppercase tracking-wider " +
                  (b.label === "Overdue"
                    ? "text-destructive"
                    : "text-muted-foreground")
                }
              >
                {b.label} · {b.tasks.length}
              </p>
              <ul className="mt-2 divide-y divide-glass-border">
                {b.tasks.map((t) => {
                  const done =
                    optimistic[t.id] !== undefined
                      ? optimistic[t.id]
                      : t.status === "completed";
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 py-2.5"
                    >
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={pending}
                        onChange={(e) =>
                          toggle(t.id, versions[t.id] ?? t.version, e.target.checked)
                        }
                        className="h-4 w-4 cursor-pointer rounded border-glass-border bg-input/60"
                        aria-label={`Mark ${t.title} ${done ? "open" : "completed"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={
                            "text-sm " +
                            (done
                              ? "text-muted-foreground line-through"
                              : "text-foreground")
                          }
                        >
                          {t.title}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {t.dueAt ? (
                            <span>Due {formatUserTime(t.dueAt, prefs)}</span>
                          ) : null}
                          {t.priority !== "normal" ? (
                            <span className="rounded-full bg-accent/40 px-1.5 py-0.5 text-[10px] uppercase">
                              {t.priority}
                            </span>
                          ) : null}
                          {t.leadId ? (
                            <Link
                              href={`/leads/${t.leadId}`}
                              className="text-foreground/80 hover:underline"
                            >
                              {t.leadName ?? "Lead"}
                            </Link>
                          ) : null}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(t.id)}
                        disabled={pending}
                        className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InlineCreate({ disabled }: { disabled: boolean }) {
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [, startTransition] = useTransition();

  function submit() {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    startTransition(async () => {
      const res = await createTaskAction({
        title: trimmed,
        dueAt: dueAt ? new Date(dueAt) : null,
        priority: "normal",
      });
      if (res.ok) {
        toast.success("Task created");
        setTitle("");
        setDueAt("");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-stretch gap-2 rounded-lg border border-glass-border bg-input/30 p-2 sm:flex-row">
      <input
        type="text"
        value={title}
        disabled={disabled}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Add a task… (press Enter)"
        className="h-9 flex-1 rounded-md border border-glass-border bg-input/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        type="datetime-local"
        value={dueAt}
        disabled={disabled}
        onChange={(e) => setDueAt(e.target.value)}
        className="h-9 rounded-md border border-glass-border bg-input/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || title.trim().length === 0}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
      >
        Add
      </button>
    </div>
  );
}
