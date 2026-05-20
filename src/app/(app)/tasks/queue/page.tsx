import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema/tasks";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { PagePoll } from "@/components/realtime/page-poll";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { QueueClient, type QueueTask, type QueueBucket } from "./_components/queue-client";

export const dynamic = "force-dynamic";

const BUCKETS = ["overdue", "today", "week", "all"] as const;

function parseBucket(raw: string | undefined): QueueBucket | undefined {
  if (!raw) return undefined;
  return (BUCKETS as readonly string[]).includes(raw)
    ? (raw as QueueBucket)
    : undefined;
}

/**
 * /tasks/queue — focused "walk through your queue" alt-render of the
 * same data /tasks renders as a list. Same `tasks` table; render-mode
 * only. The List ↔ Queue toggle in the /tasks header swaps between the
 * two; both are bookmarkable.
 *
 * Server shell pulls the rep's open tasks in queue-order
 * (dueAt ASC NULLS LAST, priority DESC, createdAt ASC), then hands off
 * to QueueClient which owns cursor / Done / Skip / Snooze / keyboard.
 *
 * Notification skip-self note: commit fdcb3a4 already excludes
 * self-authored activity rows from countUnseen, so the rep's own Done
 * burst will NOT inflate their bell. Cross-user notifications
 * (assignment, mention) continue to fire correctly.
 */
export default async function TasksQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const requestedBucket = parseBucket(sp.bucket);

  const timePrefs = await getCurrentUserTimePrefs();

  const rows = await db
    .select({
      id: tasks.id,
      version: tasks.version,
      title: tasks.title,
      description: tasks.description,
      status: sql<string>`${tasks.status}::text`,
      priority: sql<string>`${tasks.priority}::text`,
      dueAt: tasks.dueAt,
      leadId: tasks.leadId,
      accountId: tasks.accountId,
      contactId: tasks.contactId,
      opportunityId: tasks.opportunityId,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.isDeleted, false),
        eq(tasks.assignedToId, session.id),
        sql`${tasks.status} IN ('open','in_progress')`,
      ),
    )
    .orderBy(
      sql`${tasks.dueAt} ASC NULLS LAST`,
      sql`CASE ${tasks.priority}
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 3
        ELSE 4 END`,
      asc(tasks.createdAt),
    );

  const allTasks: QueueTask[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    priority: r.priority,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    leadId: r.leadId ?? null,
    accountId: r.accountId ?? null,
    contactId: r.contactId ?? null,
    opportunityId: r.opportunityId ?? null,
  }));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[{ label: "Tasks", href: "/tasks" }, { label: "Queue" }]}
      />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground">
            Task queue
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-glass-border bg-glass-1 p-1">
            <Link
              href="/tasks"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              List
            </Link>
            <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
              Queue
            </span>
          </div>
          <Link
            href="/tasks"
            className="text-xs text-muted-foreground transition hover:text-foreground hover:underline"
          >
            ← Back to list
          </Link>
        </div>
      </div>

      <QueueClient
        allTasks={allTasks}
        initialBucket={requestedBucket}
        timePrefs={timePrefs}
        viewerId={session.id}
      />
    </div>
  );
}
