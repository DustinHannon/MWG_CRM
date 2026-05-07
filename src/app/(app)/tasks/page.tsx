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
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const statusFilter = sp.status?.split(",").filter(Boolean) as
    | ("open" | "in_progress" | "completed" | "cancelled")[]
    | undefined;

  const tasks = await listTasksForUser({
    userId: session.id,
    isAdmin: session.isAdmin,
    scope: "me",
    status: statusFilter ?? ["open", "in_progress"],
  });

  const buckets = bucketTasks(tasks);
  const prefs = await getCurrentUserTimePrefs();

  return (
    <div className="px-10 py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Tasks
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">My tasks</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Things to do. Mark complete with the checkbox. Group by due date.
      </p>

      <GlassCard className="mt-6 p-4">
        <TaskListClient buckets={buckets} userId={session.id} prefs={prefs} />
      </GlassCard>
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
