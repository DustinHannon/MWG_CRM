import Link from "next/link";
import { UserTime } from "@/components/ui/user-time";
import { type TaskRow } from "@/lib/tasks";
import { EntityTasksQuickAdd } from "./entity-tasks-quick-add";

/**
 * Phase 25 §7.3 — Tasks section for entity-detail pages.
 *
 * Server component. Renders the list of tasks linked to the parent
 * entity (lead / account / contact / opportunity) plus a client-side
 * quick-add form that auto-sets the entity FK at submit time. The
 * quick-add is the canonical mechanism for creating an entity-linked
 * task from a detail page — no other entry path forks into
 * `task.created.from_*` audit variants.
 *
 * The CHECK constraint `tasks_at_most_one_parent` guarantees a task
 * has at most one parent entity at the DB layer; this section's
 * quick-add only sets the one FK matching its entity scope.
 */
export interface EntityTasksSectionProps {
  /** Which entity this section is rendering on. */
  entityType: "lead" | "account" | "contact" | "opportunity";
  /** Parent entity id; passed to the quick-add for auto-FK. */
  entityId: string;
  /** Tasks for the parent entity (already filtered + sorted). */
  tasks: TaskRow[];
  /** Current viewer — used for the assignee default in quick-add. */
  currentUserId: string;
}

export function EntityTasksSection({
  entityType,
  entityId,
  tasks,
  currentUserId,
}: EntityTasksSectionProps) {
  const open = tasks.filter(
    (t) => t.status === "open" || t.status === "in_progress",
  );
  const completed = tasks.filter((t) => t.status === "completed");

  return (
    <div className="space-y-4">
      <EntityTasksQuickAdd
        entityType={entityType}
        entityId={entityId}
        defaultAssigneeId={currentUserId}
      />

      {tasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          No tasks yet. Use the quick-add above to create one.
        </p>
      ) : (
        <div className="space-y-3">
          {open.length > 0 ? (
            <TaskGroup label="Open" tasks={open} />
          ) : null}
          {completed.length > 0 ? (
            <TaskGroup label="Completed" tasks={completed} muted />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskGroup({
  label,
  tasks,
  muted,
}: {
  label: string;
  tasks: TaskRow[];
  muted?: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label} ({tasks.length})
      </p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-muted/10">
        {tasks.map((t) => (
          <TaskRowItem key={t.id} task={t} muted={muted ?? false} />
        ))}
      </ul>
    </div>
  );
}

function TaskRowItem({ task, muted }: { task: TaskRow; muted: boolean }) {
  const overdue =
    task.dueAt !== null &&
    task.dueAt < new Date() &&
    task.status !== "completed";
  return (
    <li
      className={`flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between ${
        muted ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0">
        <p
          className={`truncate text-sm font-medium ${
            task.status === "completed" ? "line-through" : ""
          }`}
        >
          <Link
            href={`/tasks?assignee=me&status=open#task-${task.id}`}
            className="hover:underline"
          >
            {task.title}
          </Link>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {task.dueAt ? (
            <span className={overdue ? "text-destructive" : undefined}>
              Due <UserTime value={task.dueAt} mode="date" />
              {overdue ? " · overdue" : ""}
            </span>
          ) : (
            <span>No due date</span>
          )}
          <span>·</span>
          <span className="capitalize">{task.priority}</span>
          {task.assignedToName ? (
            <>
              <span>·</span>
              <span>{task.assignedToName}</span>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}
