import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listTags } from "@/lib/tags";
import {
  BUILTIN_TASK_VIEWS,
  findBuiltinTaskView,
  getSavedTaskView,
  getTaskPreferences,
  listSavedTaskViewsForUser,
  type TaskViewDefinition,
} from "@/lib/task-views";
import {
  DEFAULT_TASK_COLUMNS,
  TASK_COLUMN_KEYS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";
import { TasksListClient } from "./_components/tasks-list-client";

export const dynamic = "force-dynamic";

/**
 * /tasks — server shell. Hands off to TasksListClient for everything
 * filter / fetch / virtualization-related. The shell still:
 *
 *   - Authenticates + resolves perms (canViewOthers, canReassign,
 *     canEditOthersTasks, canApplyTags, canManageTagDefinitions).
 *   - Resolves the active view (URL `?view=` > last-used pref >
 *     `builtin:my-open`).
 *   - Resolves the active column list (URL `?cols=` > adhoc pref >
 *     view.columns > DEFAULT_TASK_COLUMNS).
 *   - Pre-fetches the tag catalogue + assignable user list + saved
 *     views so the client mounts with stable picker data.
 *   - Persists last-used view id (best-effort).
 *
 * URL state used by the page after migration:
 *   - `?view` — active view id (built-in or saved).
 *   - `?cols` — explicit column list (in-session toggle).
 *   - `?sort` / `?dir` — sort affordance from sortable column
 *     headers (kept URL-state to preserve existing UX).
 *
 * Everything else — q / status / priority / assignee / relation /
 * related / due / tag — lives in client state, initialized empty
 * (mirrors the leads pattern). The /api/tasks/list route applies the
 * active view's stored filters server-side when the request carries
 * no overlay, so empty client state renders the saved view exactly.
 * Legacy deep-link URLs with these params are no longer honored on
 * first mount (the TaskViewSelector's pick(id) also drops them on
 * view switch); this matches leads / accounts / contacts /
 * opportunities and keeps the MODIFIED badge honest.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    cols?: string;
    sort?: string;
    dir?: string;
    q?: string;
    status?: string;
    priority?: string;
    relation?: string;
    related?: string;
    due?: string;
    assignee?: string;
    tag?: string;
  }>;
}) {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewOthers = session.isAdmin || perms.canViewOthersTasks;
  const canReassign = session.isAdmin || perms.canReassignTasks;
  const canEditOthersTasks = session.isAdmin || perms.canEditOthersTasks;
  const canApplyTags = session.isAdmin || perms.canApplyTags;
  const canManageTagDefinitions =
    session.isAdmin || perms.canManageTagDefinitions;

  const sp = await searchParams;
  const timePrefs = await getCurrentUserTimePrefs();

  // Read last-used view as the default when URL doesn't pin one.
  const [prefsRow] = await db
    .select({ lastUsedTaskViewId: userPreferences.lastUsedTaskViewId })
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.id))
    .limit(1);
  const lastUsedTaskViewId = prefsRow?.lastUsedTaskViewId ?? null;

  // Resolve active view.
  const activeViewParam = sp.view ?? lastUsedTaskViewId ?? "builtin:my-open";
  let activeView: TaskViewDefinition | null = null;
  if (activeViewParam.startsWith("saved:")) {
    activeView = await getSavedTaskView(
      session.id,
      activeViewParam.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinTaskView(activeViewParam);
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

  // Resolve column list. URL > adhoc pref (built-in views only) >
  // view.columns > DEFAULT_TASK_COLUMNS.
  const taskPrefs = await getTaskPreferences(session.id);
  const baseColumns =
    activeView.columns && activeView.columns.length > 0
      ? activeView.columns
      : DEFAULT_TASK_COLUMNS;
  const urlCols = sp.cols
    ? (sp.cols
        .split(",")
        .filter((c): c is TaskColumnKey =>
          TASK_COLUMN_KEYS.includes(c as TaskColumnKey),
        ) as TaskColumnKey[])
    : null;
  let activeColumns: TaskColumnKey[];
  if (urlCols && urlCols.length > 0) {
    activeColumns = urlCols;
  } else if (
    activeView.source === "builtin" &&
    taskPrefs.adhocColumns &&
    taskPrefs.adhocColumns.length > 0
  ) {
    activeColumns = taskPrefs.adhocColumns;
  } else {
    activeColumns = baseColumns;
  }

  // Picker payloads — tags + saved views + active users (for
  // reassign). Reassign list only loaded when the viewer has the
  // perm so non-managers don't pay for the query.
  const [allTags, savedViews, assignableUsers] = await Promise.all([
    listTags(),
    listSavedTaskViewsForUser(session.id),
    canReassign
      ? db
          .select({
            id: users.id,
            displayName: users.displayName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.isActive, true))
          .orderBy(asc(users.displayName))
      : Promise.resolve([] as Array<{
          id: string;
          displayName: string;
          email: string;
        }>),
  ]);

  const visibleBuiltins = canViewOthers
    ? BUILTIN_TASK_VIEWS
    : BUILTIN_TASK_VIEWS.filter((v) => v.id !== "builtin:team-open");

  // Persist last-used view id. Fire-and-forget; failure can't break
  // the read path. The inner try/catch is intentional — best-effort
  // UPSERT only.
  try {
    await db
      .insert(userPreferences)
      .values({ userId: session.id, lastUsedTaskViewId: activeView.id })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          lastUsedTaskViewId: activeView.id,
          updatedAt: new Date(),
        },
      });
  } catch {
    // persistence is a UX nicety, not a correctness gate.
  }
  // Touch `and` import so the linter doesn't flag it as unused when
  // future filter helpers are removed from this shell.
  void and;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Tasks" }]} />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />

      <TasksListClient
        key={activeViewParam}
        user={{ id: session.id, isAdmin: session.isAdmin }}
        timePrefs={timePrefs}
        activeViewParam={activeViewParam}
        activeViewName={activeView.name}
        activeView={activeView}
        activeColumns={activeColumns}
        baseColumns={baseColumns}
        builtinViews={visibleBuiltins}
        savedViews={savedViews}
        allTags={allTags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
        }))}
        assignableUsers={assignableUsers}
        canViewOthers={canViewOthers}
        canReassign={canReassign}
        canEditOthersTasks={canEditOthersTasks}
        canApplyTags={canApplyTags}
        canManageTagDefinitions={canManageTagDefinitions}
      />
    </div>
  );
}
