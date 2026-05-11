import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listTasksForUser } from "@/lib/tasks";
import {
  BUILTIN_TASK_VIEWS,
  findBuiltinTaskView,
  getSavedTaskView,
  listSavedTaskViewsForUser,
  type TaskViewDefinition,
  type TaskViewFilters,
  type TaskViewSort,
} from "@/lib/task-views";
import { TaskTableClient } from "./_components/task-table-client";
import { TaskViewSelector } from "./_components/task-view-selector";

export const dynamic = "force-dynamic";

/**
 * /tasks — Phase 25 §7.3 redesign.
 *
 * Title is "Tasks" (no subtitle — copy convention update).
 *
 * Filters: assignee / status / priority / relation / related-entity-
 * type / due-range / free-text title search. Sort is URL-state. Built-
 * in views + per-user saved views back the picker; the same
 * `saved_views` table backs leads + tasks (entity_type='task').
 *
 * Single canonical audit names (task.completed, .reassigned, .deleted)
 * for every surface — no fork by source.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    status?: string;
    priority?: string;
    relation?: string;
    related?: string;
    due?: string;
    assignee?: string;
    sort?: string;
    dir?: string;
    q?: string;
    cursor?: string;
  }>;
}) {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewOthers = session.isAdmin || perms.canViewOthersTasks;
  const canReassign = session.isAdmin || perms.canReassignTasks;

  const sp = await searchParams;
  const prefs = await getCurrentUserTimePrefs();

  // Resolve the active view: explicit URL > default built-in.
  const activeViewId = sp.view ?? "builtin:my-open";
  let activeView: TaskViewDefinition | null = null;
  if (activeViewId.startsWith("saved:")) {
    activeView = await getSavedTaskView(
      session.id,
      activeViewId.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinTaskView(activeViewId);
  }
  // Team view requires perm; fall back to my-open if unauthorized.
  if (
    activeView &&
    activeView.id === "builtin:team-open" &&
    !canViewOthers
  ) {
    activeView = findBuiltinTaskView("builtin:my-open");
  }
  if (!activeView) activeView = findBuiltinTaskView("builtin:my-open")!;

  // URL params override the view's defaults so the user can tweak
  // and save-as-new without losing intermediate state.
  const filters: TaskViewFilters = {
    ...activeView.filters,
    ...(sp.assignee
      ? { assignee: sp.assignee as TaskViewFilters["assignee"] }
      : {}),
    ...(sp.status
      ? {
          status: sp.status.split(",").filter(Boolean) as TaskViewFilters["status"],
        }
      : {}),
    ...(sp.priority
      ? {
          priority: sp.priority
            .split(",")
            .filter(Boolean) as TaskViewFilters["priority"],
        }
      : {}),
    ...(sp.relation
      ? { relation: sp.relation as TaskViewFilters["relation"] }
      : {}),
    ...(sp.related
      ? { relatedEntity: sp.related as TaskViewFilters["relatedEntity"] }
      : {}),
    ...(sp.due
      ? { dueRange: sp.due as TaskViewFilters["dueRange"] }
      : {}),
    ...(sp.q ? { q: sp.q } : {}),
  };

  const sort: TaskViewSort =
    sp.sort && sp.dir
      ? {
          field: sp.sort as TaskViewSort["field"],
          direction: sp.dir as TaskViewSort["direction"],
        }
      : activeView.sort;

  // Resolve `me` sentinel to userId for the lib helper.
  const assigneeArg =
    filters.assignee === "me"
      ? "me"
      : filters.assignee === "any"
        ? "any"
        : filters.assignee;

  const { rows: tasks, nextCursor } = await listTasksForUser({
    userId: session.id,
    isAdmin: session.isAdmin,
    assignee: assigneeArg,
    status: filters.status,
    priority: filters.priority,
    relation: filters.relation,
    relatedEntity: filters.relatedEntity,
    dueRange: filters.dueRange,
    q: filters.q,
    sort,
    cursor: sp.cursor,
    pageSize: 50,
  });

  // Saved views for the picker. Built-ins filtered by team perm.
  const savedViews = await listSavedTaskViewsForUser(session.id);
  const visibleBuiltins = canViewOthers
    ? BUILTIN_TASK_VIEWS
    : BUILTIN_TASK_VIEWS.filter((v) => v.id !== "builtin:team-open");

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Tasks" }]} />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          {/* Phase 25 §7.3 — title is "Tasks"; subtitle removed. */}
          <h1 className="text-2xl font-semibold font-display">Tasks</h1>
        </div>
        {session.isAdmin ? (
          <Link
            href="/tasks/archived"
            className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 whitespace-nowrap transition hover:bg-muted md:inline-flex"
          >
            Archived
          </Link>
        ) : null}
      </div>

      {/* Phase 25 §7.3 — view selector + filter bar. URL-state driven,
          like the /leads filter bar. */}
      <div className="mt-5 space-y-3">
        <TaskViewSelector
          activeViewId={activeView.id}
          builtinViews={visibleBuiltins}
          savedViews={savedViews}
          currentFilters={filters}
          currentSort={sort}
        />
        <FilterBar
          assignee={filters.assignee ?? "me"}
          status={filters.status ?? []}
          priority={filters.priority ?? []}
          relation={filters.relation ?? "all"}
          relatedEntity={filters.relatedEntity}
          dueRange={filters.dueRange ?? "all"}
          q={filters.q ?? ""}
          canViewOthers={canViewOthers}
        />
      </div>

      <GlassCard className="mt-6 p-4">
        <TaskTableClient
          tasks={tasks}
          userId={session.id}
          isAdmin={session.isAdmin}
          canReassign={canReassign}
          prefs={prefs}
          sort={sort}
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
                href={appendCursor(sp, nextCursor)}
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

/**
 * Build the "Load more" URL preserving every active filter + sort.
 * Mirrors the leads cursor-link pattern.
 */
function appendCursor(
  sp: Record<string, string | undefined>,
  cursor: string,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== "cursor") params.set(k, v);
  }
  params.set("cursor", cursor);
  return `/tasks?${params.toString()}`;
}

/**
 * Server-rendered filter bar. URL-state only — each control is a link
 * that adjusts the active query string. No JS state.
 */
function FilterBar({
  assignee,
  status,
  priority,
  relation,
  relatedEntity,
  dueRange,
  q,
  canViewOthers,
}: {
  assignee: string;
  status: string[];
  priority: string[];
  relation: string;
  relatedEntity: string | undefined;
  dueRange: string;
  q: string;
  canViewOthers: boolean;
}) {
  return (
    <form
      method="get"
      action="/tasks"
      className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-3 text-xs"
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Assignee</span>
        <select
          name="assignee"
          defaultValue={assignee}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="me">Me</option>
          {canViewOthers ? <option value="any">Anyone</option> : null}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Status</span>
        <select
          name="status"
          defaultValue={status.join(",") || ""}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="open,in_progress">Open</option>
          <option value="completed">Completed</option>
          <option value="open,in_progress,completed,cancelled">All</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Priority</span>
        <select
          name="priority"
          defaultValue={priority.join(",")}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="">Any</option>
          <option value="urgent">Urgent</option>
          <option value="high,urgent">High +</option>
          <option value="normal,high,urgent">Normal +</option>
          <option value="low">Low only</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Related to</span>
        <select
          name="relation"
          defaultValue={relation}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="all">All</option>
          <option value="standalone">Standalone</option>
          <option value="linked">Linked to entity</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Entity type</span>
        <select
          name="related"
          defaultValue={relatedEntity ?? ""}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="">Any</option>
          <option value="lead">Lead</option>
          <option value="account">Account</option>
          <option value="contact">Contact</option>
          <option value="opportunity">Opportunity</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Due</span>
        <select
          name="due"
          defaultValue={dueRange}
          className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
        >
          <option value="all">Any</option>
          <option value="overdue">Overdue</option>
          <option value="today">Today</option>
          <option value="this_week">This week</option>
          <option value="later">Later</option>
          <option value="none">No date</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Search title</span>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="contains…"
          className="h-8 w-40 rounded-md border border-border bg-input/60 px-2 text-xs"
        />
      </label>
      <button
        type="submit"
        className="h-8 rounded-md border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20"
      >
        Apply
      </button>
      <Link
        href="/tasks"
        className="h-8 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Reset
      </Link>
    </form>
  );
}
