"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createTaskAction } from "@/app/(app)/tasks/actions";

/**
 * Phase 25 §7.3 — entity-detail Tasks tab quick-add. Auto-sets the
 * parent entity FK matching the page scope (e.g. `leadId` on
 * /leads/[id]). No "Related to" picker here — the entity is implied.
 *
 * Single canonical audit event: `task.created` (via `createTaskAction`
 * → `createTask` in lib/tasks). No fork into
 * `task.created.from_lead_tab` etc.; the audit's `after_json` carries
 * the FK so post-hoc analysis can group by entity type.
 */
export function EntityTasksQuickAdd({
  entityType,
  entityId,
  defaultAssigneeId,
}: {
  entityType: "lead" | "account" | "contact" | "opportunity";
  entityId: string;
  defaultAssigneeId: string;
}) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<
    "low" | "normal" | "high" | "urgent"
  >("normal");
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("Task needs a title.");
      return;
    }
    startTransition(async () => {
      const fkPatch =
        entityType === "lead"
          ? { leadId: entityId }
          : entityType === "account"
            ? { accountId: entityId }
            : entityType === "contact"
              ? { contactId: entityId }
              : { opportunityId: entityId };

      const res = await createTaskAction({
        title: trimmed,
        priority,
        dueAt: dueDate ? new Date(dueDate) : null,
        assignedToId: defaultAssigneeId,
        ...fkPatch,
      });
      if (res.ok) {
        toast.success("Task added");
        setTitle("");
        setDueDate("");
        setPriority("normal");
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-center"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task…"
        disabled={pending}
        className="min-w-0 flex-1 rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        disabled={pending}
        aria-label="Due date"
        className="rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <select
        value={priority}
        onChange={(e) =>
          setPriority(
            e.target.value as "low" | "normal" | "high" | "urgent",
          )
        }
        disabled={pending}
        aria-label="Priority"
        className="rounded-md border border-border bg-input/60 px-3 py-2 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </select>
      <button
        type="submit"
        disabled={pending || !title.trim()}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add"}
      </button>
    </form>
  );
}
