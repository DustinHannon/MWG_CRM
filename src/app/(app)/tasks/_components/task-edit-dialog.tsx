"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { TagSectionClient } from "@/components/tags/tag-section-client";
import type { TaskRow } from "@/lib/tasks";
import { updateTaskAction } from "../actions";

interface TaskEditDialogProps {
  task: TaskRow;
  assignableUsers: { id: string; displayName: string; email: string }[];
  canReassign: boolean;
  /**
   * Whether the current user can apply / remove tags. Server gate
   * still enforces — these props only drive UI affordances.
   */
  canApplyTags?: boolean;
  canManageTagDefinitions?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Inline edit dialog for a task row. Replaces the per-task detail
 * page we don't have. Covers the fields the legacy update path
 * supports (title, description, status, priority, due date,
 * assignee) plus a Tags section that calls the canonical
 * `applyTagAction` / `removeTagAction` via `<TagSectionClient>`.
 *
 * The reassign control hides when the viewer lacks reassign perm;
 * the action layer enforces the same gate as a defence-in-depth
 * check.
 */
export function TaskEditDialog({
  task,
  assignableUsers,
  canReassign,
  canApplyTags = false,
  canManageTagDefinitions = false,
  onClose,
  onSaved,
}: TaskEditDialogProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [status, setStatus] = useState<
    "open" | "in_progress" | "completed" | "cancelled"
  >(task.status as "open" | "in_progress" | "completed" | "cancelled");
  const [priority, setPriority] = useState<
    "low" | "normal" | "high" | "urgent"
  >(task.priority as "low" | "normal" | "high" | "urgent");
  const [dueAt, setDueAt] = useState<string>(
    task.dueAt ? formatDateForInput(task.dueAt) : "",
  );
  const [assignedToId, setAssignedToId] = useState<string>(
    task.assignedToId ?? "",
  );
  const [pending, startTransition] = useTransition();

  // Escape closes the dialog — WCAG 2.1.2. Pending writes block
  // dismissal so the user doesn't think they cancelled when the
  // server is mid-update.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("Task needs a title.");
      return;
    }
    startTransition(async () => {
      const res = await updateTaskAction({
        id: task.id,
        version: task.version,
        title: trimmed,
        description: description.trim() === "" ? null : description.trim(),
        status,
        priority,
        // Append explicit local-midnight so `new Date("YYYY-MM-DD")`
        // is not interpreted as UTC. With local-TZ parsing, the date
        // round-trips through the input control (display + save) at
        // the same calendar day; the bare ISO date string would
        // shift one day west in negative-UTC zones at save time.
        dueAt: dueAt ? new Date(`${dueAt}T00:00:00`) : null,
        assignedToId: assignedToId ? assignedToId : null,
      });
      if (res.ok) {
        toast.success("Task saved.");
        onSaved();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit task ${task.title}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => {
        // Backdrop click dismisses, but not during an in-flight save —
        // matches the BulkTagButton pattern so users don't lose their
        // edits to an accidental click while pending.
        if (!pending) onClose();
      }}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold">Edit task</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="mt-4 space-y-4"
        >
          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Title
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              disabled={pending}
              className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>

          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={pending}
              className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-xs uppercase tracking-wide text-muted-foreground">
              Status
              <select
                value={status}
                onChange={(e) =>
                  setStatus(
                    e.target.value as
                      | "open"
                      | "in_progress"
                      | "completed"
                      | "cancelled",
                  )
                }
                disabled={pending}
                className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>

            <label className="block text-xs uppercase tracking-wide text-muted-foreground">
              Priority
              <select
                value={priority}
                onChange={(e) =>
                  setPriority(
                    e.target.value as "low" | "normal" | "high" | "urgent",
                  )
                }
                disabled={pending}
                className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>

            <label className="block text-xs uppercase tracking-wide text-muted-foreground">
              Due date
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                disabled={pending}
                className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </label>

            <label className="block text-xs uppercase tracking-wide text-muted-foreground">
              Assignee
              {canReassign && assignableUsers.length > 0 ? (
                <select
                  value={assignedToId}
                  onChange={(e) => setAssignedToId(e.target.value)}
                  disabled={pending}
                  className="mt-1 block w-full rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  <option value="">Unassigned</option>
                  {assignableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName} ({u.email})
                    </option>
                  ))}
                </select>
              ) : (
                <span className="mt-1 block text-sm text-foreground/80">
                  {task.assignedToName ?? "Unassigned"}
                </span>
              )}
            </label>
          </div>

          <section className="space-y-2 border-t border-border pt-4">
            <h4 className="text-xs uppercase tracking-wide text-muted-foreground">
              Tags
            </h4>
            <TagSectionClient
              entityType="task"
              entityId={task.id}
              initialTags={(task.tags ?? []).map((t) => ({
                id: t.id,
                name: t.name,
                color: t.color ?? "slate",
              }))}
              canApply={canApplyTags}
              canManage={canManageTagDefinitions}
            />
          </section>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !title.trim()}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Format a Date as YYYY-MM-DD for an <input type="date">.
 * Uses the user's local TZ so the date control matches what they see
 * in the table cell.
 */
function formatDateForInput(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
