import Link from "next/link";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import type { TaskRow } from "@/lib/tasks";

/**
 * Phase 25 §7.3 — dashboard "My open tasks" widget. Top 5 by due date
 * for the current viewer (open or in_progress status). Overdue rows
 * are flagged via text color; the related entity (if any) appears
 * inline with a click-through link. Footer surfaces "View all" →
 * /tasks?assignee=me&status=open for the full filtered surface.
 *
 * Server component. Loaded by the dashboard page via
 * `listOpenTasksForUser(viewerId, 5)`.
 */
export function MyOpenTasksWidget({ tasks }: { tasks: TaskRow[] }) {
  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            My open tasks
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            Top 5 by due date. Overdue items shown in red.
          </p>
        </div>
        <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      {tasks.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          You{`'`}re all clear. New tasks appear here when assigned to you.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-muted/10">
          {tasks.map((t) => (
            <WidgetRow key={t.id} task={t} />
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-end">
        <Link
          href="/tasks?assignee=me&status=open"
          className="text-xs text-muted-foreground transition hover:text-foreground hover:underline"
        >
          View all →
        </Link>
      </div>
    </GlassCard>
  );
}

function WidgetRow({ task }: { task: TaskRow }) {
  const overdue =
    task.dueAt !== null &&
    task.dueAt < new Date() &&
    task.status !== "completed";
  return (
    <li className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{task.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {task.dueAt ? (
            <span className={overdue ? "text-destructive font-medium" : undefined}>
              Due <UserTime value={task.dueAt} mode="date" />
              {overdue ? " · overdue" : ""}
            </span>
          ) : (
            <span>No due date</span>
          )}
          <RelatedTo task={task} />
        </p>
      </div>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground capitalize">
        {task.priority}
      </span>
    </li>
  );
}

/**
 * Inline Related-to renderer — shows the linked parent entity (if
 * any) with a click-through link to its detail page. Em-dash when
 * standalone. CHECK `tasks_at_most_one_parent` guarantees at most
 * one FK is set so the early-returns here cover all cases.
 */
function RelatedTo({ task }: { task: TaskRow }) {
  if (task.leadId && task.leadName) {
    return (
      <>
        <span>·</span>
        <Link
          href={`/leads/${task.leadId}`}
          className="text-foreground/80 hover:text-foreground hover:underline"
        >
          {task.leadName}
        </Link>
      </>
    );
  }
  if (task.accountId && task.accountName) {
    return (
      <>
        <span>·</span>
        <Link
          href={`/accounts/${task.accountId}`}
          className="text-foreground/80 hover:text-foreground hover:underline"
        >
          {task.accountName}
        </Link>
      </>
    );
  }
  if (task.contactId && task.contactName) {
    return (
      <>
        <span>·</span>
        <Link
          href={`/contacts/${task.contactId}`}
          className="text-foreground/80 hover:text-foreground hover:underline"
        >
          {task.contactName}
        </Link>
      </>
    );
  }
  if (task.opportunityId && task.opportunityName) {
    return (
      <>
        <span>·</span>
        <Link
          href={`/opportunities/${task.opportunityId}`}
          className="text-foreground/80 hover:text-foreground hover:underline"
        >
          {task.opportunityName}
        </Link>
      </>
    );
  }
  return null;
}
