"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatUserTime, type TimePrefs } from "@/lib/format-time";
import { PriorityPill } from "@/components/ui/priority-pill";
import { StatusPill } from "@/components/ui/status-pill";
// Import UserChip directly so the barrel doesn't pull in the
// hover-card (which transitively imports the postgres-js client).
import { UserChip } from "@/components/user-display/user-chip";
import type { TaskRow } from "@/lib/tasks";
import { toggleTaskCompleteAction } from "../actions";
import {
  bulkCompleteTasksAction,
  bulkDeleteTasksAction,
} from "../view-actions";

/**
 * Phase 25 §7.3 — Tasks page table-style client.
 *
 * Replaces the prior bucketed-by-due-window TaskListClient with a
 * sortable flat table + per-row selection + bulk-action toolbar.
 * The filter bar lives in the server page (URL-state driven, like
 * /leads); this component handles intra-table interactions only
 * (select / sort / toggle-complete / bulk).
 *
 * Sort is URL-state too — the column header click sets ?sort=field
 * &dir=asc and navigates; this client only renders the carets.
 */
export interface TaskTableClientProps {
  tasks: TaskRow[];
  userId: string;
  isAdmin: boolean;
  canReassign: boolean;
  prefs: TimePrefs;
  /** Current sort, surfaced by the server page from URL params. */
  sort: {
    field:
      | "dueAt"
      | "priority"
      | "title"
      | "assignee"
      | "status"
      | "createdAt";
    direction: "asc" | "desc";
  };
}

const COLUMNS = [
  { key: "title", label: "Title", sortable: true },
  { key: "related", label: "Related to", sortable: false },
  { key: "dueAt", label: "Due", sortable: true },
  { key: "priority", label: "Priority", sortable: true },
  { key: "assignee", label: "Assignee", sortable: true },
  { key: "status", label: "Status", sortable: true },
] as const;

export function TaskTableClient({
  tasks,
  userId,
  isAdmin,
  canReassign,
  prefs,
  sort,
}: TaskTableClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allSelected = useMemo(
    () => tasks.length > 0 && tasks.every((t) => selected.has(t.id)),
    [tasks, selected],
  );
  const someSelected = selected.size > 0 && !allSelected;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tasks.map((t) => t.id)));
    }
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleComplete(task: TaskRow) {
    const next = task.status !== "completed";
    startTransition(async () => {
      const res = await toggleTaskCompleteAction(task.id, task.version, next);
      if (!res.ok) {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      } else {
        router.refresh();
      }
    });
  }

  function bulkComplete() {
    if (selected.size === 0) return;
    startTransition(async () => {
      const res = await bulkCompleteTasksAction({ ids: Array.from(selected) });
      if (res.ok) {
        toast.success(`Marked ${res.data.updated} task(s) complete`);
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function bulkDelete() {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Delete ${selected.size} task(s)? This soft-deletes them; the retention cron purges after 730 days.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await bulkDeleteTasksAction({ ids: Array.from(selected) });
      if (res.ok) {
        toast.success(`Deleted ${res.data.updated} task(s)`);
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function sortHref(field: (typeof COLUMNS)[number]["key"]) {
    if (field === "related") return "#";
    const direction =
      sort.field === field && sort.direction === "asc" ? "desc" : "asc";
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    params.set("sort", field);
    params.set("dir", direction);
    return `?${params.toString()}`;
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No tasks match the current filters.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm">
          <span className="font-medium text-primary">
            {selected.size} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={bulkComplete}
              disabled={pending}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
            >
              Complete
            </button>
            <button
              type="button"
              onClick={bulkDelete}
              disabled={pending}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/20"
            >
              Delete
            </button>
            {canReassign ? (
              <span
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
                title="Open the per-task edit dialog to reassign (bulk reassign UI is coming next)"
              >
                Reassign… (per-task)
              </span>
            ) : null}
            <button
              type="button"
              onClick={clearSelection}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border bg-muted/10">
        <table className="min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all"
                  className="h-4 w-4 cursor-pointer"
                />
              </th>
              <th className="px-3 py-2 w-8">{/* complete-toggle */}</th>
              {COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium">
                  {col.sortable ? (
                    <Link
                      href={sortHref(col.key)}
                      scroll={false}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {col.label}
                      <SortIndicator
                        active={sort.field === col.key}
                        direction={sort.direction}
                      />
                    </Link>
                  ) : (
                    <span>{col.label}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {tasks.map((t) => (
              <TaskTableRow
                key={t.id}
                task={t}
                checked={selected.has(t.id)}
                onToggleSelect={() => toggleRow(t.id)}
                onToggleComplete={() => toggleComplete(t)}
                viewerId={userId}
                prefs={prefs}
                disabled={pending}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* canReassign / isAdmin currently unused but kept here so the
          fast-follow bulk-reassign modal can read them in props
          without a signature change. */}
      {!isAdmin && false ? <span /> : null}
    </div>
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: "asc" | "desc";
}) {
  if (!active) return <span className="opacity-30">↕</span>;
  return <span>{direction === "asc" ? "↑" : "↓"}</span>;
}

function TaskTableRow({
  task,
  checked,
  onToggleSelect,
  onToggleComplete,
  viewerId,
  prefs,
  disabled,
}: {
  task: TaskRow;
  checked: boolean;
  onToggleSelect: () => void;
  onToggleComplete: () => void;
  viewerId: string;
  prefs: TimePrefs;
  disabled: boolean;
}) {
  const overdue =
    task.dueAt !== null &&
    task.dueAt < new Date() &&
    task.status !== "completed";
  const isCompleted = task.status === "completed";
  return (
    <tr
      className={
        checked
          ? "bg-primary/5 align-top"
          : isCompleted
            ? "opacity-60 align-top"
            : "align-top hover:bg-muted/20"
      }
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleSelect}
          disabled={disabled}
          aria-label={`Select ${task.title}`}
          className="h-4 w-4 cursor-pointer"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={isCompleted}
          onChange={onToggleComplete}
          disabled={disabled}
          aria-label={`Mark ${task.title} ${isCompleted ? "open" : "complete"}`}
          className="h-4 w-4 cursor-pointer"
        />
      </td>
      <td className={`px-3 py-2 ${isCompleted ? "line-through" : ""}`}>
        <span className="font-medium">{task.title}</span>
        {task.description ? (
          <span className="ml-2 text-xs text-muted-foreground">
            {task.description.length > 80
              ? task.description.slice(0, 80) + "…"
              : task.description}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs">
        <RelatedTo task={task} />
      </td>
      <td className="px-3 py-2 text-xs">
        {task.dueAt ? (
          <span className={overdue ? "text-destructive font-medium" : undefined}>
            {formatUserTime(task.dueAt, prefs, "date")}
            {overdue ? " · overdue" : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <PriorityPill priority={task.priority} />
      </td>
      <td className="px-3 py-2 text-xs">
        {task.assignedToId ? (
          task.assignedToId === viewerId ? (
            <span className="text-muted-foreground">You</span>
          ) : (
            <UserChip
              user={{
                id: task.assignedToId,
                displayName: task.assignedToName,
                photoUrl: null,
              }}
            />
          )
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <StatusPill status={task.status} />
      </td>
    </tr>
  );
}

function RelatedTo({ task }: { task: TaskRow }) {
  if (task.leadId && task.leadName) {
    return (
      <Link
        href={`/leads/${task.leadId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Lead
        </span>
        {task.leadName}
      </Link>
    );
  }
  if (task.accountId && task.accountName) {
    return (
      <Link
        href={`/accounts/${task.accountId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Account
        </span>
        {task.accountName}
      </Link>
    );
  }
  if (task.contactId && task.contactName) {
    return (
      <Link
        href={`/contacts/${task.contactId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Contact
        </span>
        {task.contactName}
      </Link>
    );
  }
  if (task.opportunityId && task.opportunityName) {
    return (
      <Link
        href={`/opportunities/${task.opportunityId}`}
        className="inline-flex items-center gap-1 text-foreground/80 hover:underline"
      >
        <span className="rounded-sm bg-muted/40 px-1 text-[10px] uppercase">
          Opportunity
        </span>
        {task.opportunityName}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
