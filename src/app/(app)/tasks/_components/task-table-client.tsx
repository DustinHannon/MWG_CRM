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
import { TagsCell } from "@/components/tags/tags-cell";
import type { TaskRow } from "@/lib/tasks";
import {
  AVAILABLE_TASK_COLUMNS,
  TASK_SORTABLE_COLUMNS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";
import { toggleTaskCompleteAction } from "../actions";
import {
  bulkCompleteTasksAction,
  bulkDeleteTasksAction,
  bulkReassignTasksAction,
} from "../view-actions";
import { TaskEditDialog } from "./task-edit-dialog";

/**
 * Tasks page table-style client.
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
  /** active users for the bulk-reassign modal.
   * Empty array when the viewer lacks reassign perm; the toolbar
   * hides the Reassign button in that case. */
  assignableUsers: { id: string; displayName: string; email: string }[];
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
  /** Visible columns, resolved server-side from the active view +
   * URL `?cols=` + adhoc preference. */
  columns: TaskColumnKey[];
  /**
   * Tag permission flags. The server gate still enforces; these
   * props only hide affordances client-side so users without the
   * perm don't see broken controls.
   */
  canApplyTags: boolean;
  canManageTagDefinitions: boolean;
}

export function TaskTableClient({
  tasks,
  userId,
  isAdmin,
  canReassign,
  assignableUsers,
  prefs,
  sort,
  columns,
  canApplyTags,
  canManageTagDefinitions,
}: TaskTableClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // bulk-reassign modal state.
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>("");
  // edit-dialog state. Holds the task currently open for inline
  // editing; null when the dialog is closed. The dialog mounts a
  // TagSection so users can apply/remove tags on a task without a
  // dedicated detail page.
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);

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

  function openReassign() {
    setReassignTo("");
    setReassignOpen(true);
  }

  function confirmReassign() {
    if (!reassignTo) {
      toast.error("Pick an assignee first.");
      return;
    }
    if (selected.size === 0) return;
    startTransition(async () => {
      const res = await bulkReassignTasksAction({
        ids: Array.from(selected),
        newAssigneeId: reassignTo,
      });
      if (res.ok) {
        toast.success(`Reassigned ${res.data.updated} task(s)`);
        setReassignOpen(false);
        setReassignTo("");
        clearSelection();
        router.refresh();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function sortHref(field: TaskColumnKey) {
    if (!TASK_SORTABLE_COLUMNS.has(field)) return "#";
    const direction =
      sort.field === (field as typeof sort.field) &&
      sort.direction === "asc"
        ? "desc"
        : "asc";
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    params.set("sort", field);
    params.set("dir", direction);
    return `?${params.toString()}`;
  }

  /** Column label lookup keyed by column key. */
  const colLabel = (key: TaskColumnKey) =>
    AVAILABLE_TASK_COLUMNS.find((c) => c.key === key)?.label ?? key;

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
            {canReassign && assignableUsers.length > 0 ? (
              <button
                type="button"
                onClick={openReassign}
                disabled={pending}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs hover:bg-muted"
              >
                Reassign…
              </button>
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
              {columns.map((key) => {
                const sortable = TASK_SORTABLE_COLUMNS.has(key);
                return (
                  <th key={key} className="px-3 py-2 font-medium">
                    {sortable ? (
                      <Link
                        href={sortHref(key)}
                        scroll={false}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {colLabel(key)}
                        <SortIndicator
                          active={sort.field === (key as typeof sort.field)}
                          direction={sort.direction}
                        />
                      </Link>
                    ) : (
                      <span>{colLabel(key)}</span>
                    )}
                  </th>
                );
              })}
              <th className="w-10 px-2 py-2" aria-label="Row actions" />
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
                onEdit={() => setEditingTask(t)}
                viewerId={userId}
                prefs={prefs}
                disabled={pending}
                columns={columns}
              />
            ))}
          </tbody>
        </table>
      </div>

      {editingTask ? (
        <TaskEditDialog
          task={editingTask}
          assignableUsers={assignableUsers}
          canReassign={canReassign}
          canApplyTags={canApplyTags}
          canManageTagDefinitions={canManageTagDefinitions}
          onClose={() => setEditingTask(null)}
          onSaved={() => {
            setEditingTask(null);
            router.refresh();
          }}
        />
      ) : null}

      {/* bulk-reassign modal. Simple
          inline dialog (no Radix dependency) — picker + Confirm +
          Cancel. Backed by bulkReassignTasksAction; the server
          gate-checks canReassignTasks before the UPDATE fires. */}
      {reassignOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reassign selected tasks"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">
              Reassign {selected.size} task{selected.size === 1 ? "" : "s"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The new assignee will receive the task; this emits a
              `task.reassigned` audit per task. Notifications follow
              the recipient&apos;s preferences.
            </p>
            <label className="mt-4 block text-xs uppercase tracking-wide text-muted-foreground">
              Assign to
            </label>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              disabled={pending}
              className="mt-1 h-9 w-full rounded-md border border-border bg-input/60 px-2 text-sm"
            >
              <option value="">— select user —</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.email})
                </option>
              ))}
            </select>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReassignOpen(false)}
                disabled={pending}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReassign}
                disabled={pending || !reassignTo}
                className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Reassigning…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* isAdmin currently informational only — could surface admin-
          specific column controls in a later iteration. */}
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
  columns,
  onEdit,
}: {
  task: TaskRow;
  checked: boolean;
  onToggleSelect: () => void;
  onToggleComplete: () => void;
  viewerId: string;
  prefs: TimePrefs;
  disabled: boolean;
  columns: TaskColumnKey[];
  onEdit: () => void;
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
      {columns.map((key) => (
        <td
          key={key}
          className={`px-3 py-2 text-xs ${
            key === "title" && isCompleted ? "line-through" : ""
          }`}
        >
          {renderTaskCell(task, key, { viewerId, prefs, overdue })}
        </td>
      ))}
      <td className="px-2 py-2 text-right align-middle">
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          aria-label={`Edit ${task.title}`}
          className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

/**
 * Render the cell body for a given task + column key. Centralised so
 * the column-chooser system can swap columns in/out without touching
 * the row template.
 */
function renderTaskCell(
  task: TaskRow,
  key: TaskColumnKey,
  ctx: { viewerId: string; prefs: TimePrefs; overdue: boolean },
) {
  switch (key) {
    case "title":
      return (
        <>
          <span className="font-medium text-sm">{task.title}</span>
          {task.description ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {task.description.length > 80
                ? task.description.slice(0, 80) + "…"
                : task.description}
            </span>
          ) : null}
        </>
      );
    case "related":
      return <RelatedTo task={task} />;
    case "dueAt":
      return task.dueAt ? (
        <span
          className={ctx.overdue ? "text-destructive font-medium" : undefined}
        >
          {formatUserTime(task.dueAt, ctx.prefs, "date")}
          {ctx.overdue ? " · overdue" : ""}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "priority":
      return <PriorityPill priority={task.priority} />;
    case "assignee":
      return task.assignedToId ? (
        task.assignedToId === ctx.viewerId ? (
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
      );
    case "status":
      return <StatusPill status={task.status} />;
    case "tags":
      return <TagsCell tags={task.tags} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(task.createdAt, ctx.prefs, "date")}
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(task.updatedAt, ctx.prefs, "date")}
        </span>
      );
    default: {
      // Exhaustiveness check — TS errors here if a new key is added
      // to AVAILABLE_TASK_COLUMNS but not handled above.
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
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
