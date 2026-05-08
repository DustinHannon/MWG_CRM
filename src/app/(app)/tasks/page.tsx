import Link from "next/link";
import { GlassCard } from "@/components/ui/glass-card";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { listTasksForUser, type TaskRow } from "@/lib/tasks";
import { TaskListClient } from "./_components/task-list-client";

export const dynamic = "force-dynamic";

/**
 * /tasks — primary task list. Filters: status (Open default), assignee
 * (Me default), due window (Overdue / Today / This Week / Later / No Date).
 * Group by due bucket. Inline-create at top.
 *
 * Phase 9C — cursor pagination on (due_at NULLS LAST, id DESC) at
 * pageSize 50. Bucketing happens client-side over a single page; users
 * can "Load more" to extend the list. At 1M+ tasks this keeps the
 * server-side scan bounded by the composite index.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const statusFilter = sp.status?.split(",").filter(Boolean) as
    | ("open" | "in_progress" | "completed" | "cancelled")[]
    | undefined;

  const { rows: tasks, nextCursor } = await listTasksForUser({
    userId: session.id,
    isAdmin: session.isAdmin,
    scope: "me",
    status: statusFilter ?? ["open", "in_progress"],
    cursor: sp.cursor,
    pageSize: 50,
  });

  const buckets = bucketTasks(tasks);
  const prefs = await getCurrentUserTimePrefs();

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Tasks
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">My tasks</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Things to do. Mark complete with the checkbox. Group by due date.
          </p>
        </div>
        {session.isAdmin ? (
          <Link
            href="/tasks/archived"
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted"
          >
            Archived
          </Link>
        ) : null}
      </div>

      <GlassCard className="mt-6 p-4">
        <TaskListClient
          buckets={buckets}
          userId={session.id}
          isAdmin={session.isAdmin}
          prefs={prefs}
        />
      </GlassCard>

      {nextCursor || sp.cursor ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>{sp.cursor ? "Showing more results" : "Showing first 50"}</span>
          <div className="flex gap-2">
            {sp.cursor ? (
              <Link
                href="/tasks"
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                ← Back to start
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={`/tasks?cursor=${encodeURIComponent(nextCursor)}${sp.status ? `&status=${encodeURIComponent(sp.status)}` : ""}`}
                className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
              >
                Load more →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function bucketTasks(
  list: TaskRow[],
): { label: string; tasks: TaskRow[] }[] {
  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const sevenDaysOut = new Date(now);
  sevenDaysOut.setDate(now.getDate() + 7);

  const overdue: TaskRow[] = [];
  const today: TaskRow[] = [];
  const thisWeek: TaskRow[] = [];
  const later: TaskRow[] = [];
  const none: TaskRow[] = [];

  for (const t of list) {
    if (!t.dueAt) {
      none.push(t);
      continue;
    }
    const d = new Date(t.dueAt);
    if (d < now && t.status !== "completed") {
      overdue.push(t);
    } else if (d <= todayEnd) {
      today.push(t);
    } else if (d <= sevenDaysOut) {
      thisWeek.push(t);
    } else {
      later.push(t);
    }
  }

  const buckets = [];
  if (overdue.length > 0) buckets.push({ label: "Overdue", tasks: overdue });
  if (today.length > 0) buckets.push({ label: "Today", tasks: today });
  if (thisWeek.length > 0) buckets.push({ label: "This week", tasks: thisWeek });
  if (later.length > 0) buckets.push({ label: "Later", tasks: later });
  if (none.length > 0) buckets.push({ label: "No due date", tasks: none });
  return buckets;
}
