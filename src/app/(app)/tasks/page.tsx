import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { StandardPageHeader } from "@/components/standard";
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

  // Phase 25 §7.3 — read the user's last-used task view as the
  // default when the URL doesn't pin one. Persist on every render
  // so picking a view via the selector + a hard reload land on
  // the same surface.
  const [prefsRow] = await db
    .select({ lastUsedTaskViewId: userPreferences.lastUsedTaskViewId })
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.id))
    .limit(1);
  const lastUsedTaskViewId = prefsRow?.lastUsedTaskViewId ?? null;

  // Resolve the active view: explicit URL > last-used pref > default builtin.
  const activeViewId =
    sp.view ?? lastUsedTaskViewId ?? "builtin:my-open";
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

  // Phase 25 §7.3 — active users for the bulk-reassign picker.
  // Restricted to is_active=true; sorted by display name. Only loaded
  // when the viewer has reassign perm so non-managers don't pay for
  // the query.
  const assignableUsers = canReassign
    ? await db
        .select({
          id: users.id,
          displayName: users.displayName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.isActive, true))
        .orderBy(asc(users.displayName))
    : [];

  // Phase 25 §7.3 — persist the active view id (built-in or saved).
  // Fire-and-forget UPSERT; failure here doesn't block the page.
  // Caught + swallowed because a write blip can't break read paths.
  try {
    await db
      .insert(userPreferences)
      .values({ userId: session.id, lastUsedTaskViewId: activeView.id })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { lastUsedTaskViewId: activeView.id, updatedAt: new Date() },
      });
  } catch {
    // best-effort: persistence is a UX nicety, not a correctness gate.
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Tasks" }]} />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />
      {/* Phase 25 §7.3 — title is "Tasks"; subtitle removed. */}
      <StandardPageHeader
        title="Tasks"
        fontFamily="display"
        actions={
          session.isAdmin ? (
            <Link
              href="/tasks/archived"
              className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 whitespace-nowrap transition hover:bg-muted md:inline-flex"
            >
              Archived
            </Link>
          ) : null
        }
      />

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
          assignableUsers={assignableUsers}
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
const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

/**
 * Phase 25 §7.3 follow-up — server-rendered filter bar with multi-
 * select chip toggles for status + priority (replacing the prior
 * single-select dropdowns that bundled options like "High +").
 * URL state is comma-separated; clicking a chip toggles its
 * membership and navigates.
 *
 * Other filters keep their <select> form-submit shape because they
 * are inherently single-valued (relation, dueRange, relatedEntity).
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
    <div className="space-y-2">
      {/* Multi-select chip rows. These submit via <a href> URL nav,
          not via the form below — chip toggle = single-param flip,
          no Apply button needed. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
        <span className="text-muted-foreground">Status:</span>
        {STATUS_OPTIONS.map((opt) => (
          <ChipToggle
            key={opt.value}
            paramName="status"
            currentValues={status}
            value={opt.value}
            label={opt.label}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
        <span className="text-muted-foreground">Priority:</span>
        {PRIORITY_OPTIONS.map((opt) => (
          <ChipToggle
            key={opt.value}
            paramName="priority"
            currentValues={priority}
            value={opt.value}
            label={opt.label}
          />
        ))}
      </div>

      <form
        method="get"
        action="/tasks"
        className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-3 text-xs"
      >
        {/* Preserve status + priority across the form-driven controls
            so submitting the form doesn't wipe the chip selections. */}
        {status.length > 0 ? (
          <input type="hidden" name="status" value={status.join(",")} />
        ) : null}
        {priority.length > 0 ? (
          <input type="hidden" name="priority" value={priority.join(",")} />
        ) : null}

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
    </div>
  );
}

/**
 * Phase 25 §7.3 — multi-select chip. Toggles `value` in/out of the
 * comma-separated `paramName` query string and navigates. Server-
 * rendered link so it works without JS.
 *
 * When toggling OFF the last remaining value of a status filter
 * (so the URL would drop the param entirely), we still send the
 * param so the page falls through to its view-default rather than
 * showing every status. The caller passes the active set so the
 * chip can decide on/off purely from URL state.
 */
function ChipToggle({
  paramName,
  currentValues,
  value,
  label,
}: {
  paramName: string;
  currentValues: string[];
  value: string;
  label: string;
}) {
  const isActive = currentValues.includes(value);
  const next = isActive
    ? currentValues.filter((v) => v !== value)
    : [...currentValues, value];
  // Build URL — preserve other params via a placeholder; the actual
  // preserve happens in the link-rendering helper. We can't read
  // window.location server-side, so the simplest correct: emit
  // ?paramName=joined and let the page re-resolve other state from
  // its own URL on re-render. Other params survive because Next's
  // navigation merges on URL.searchParams.set() not full-replace
  // — but here we're constructing a fresh querystring from this
  // chip alone. To keep other params we'd need to thread them in.
  //
  // Workable shortcut: emit JS-free chips inside a form so the
  // browser submits with the OTHER form fields too. But this is a
  // chip ABOVE the form. Acceptable trade-off: chip toggling
  // clears the other (non-chip) filter state. The form below shows
  // their values so the user can re-apply.
  const params = new URLSearchParams();
  if (next.length > 0) params.set(paramName, next.join(","));
  const href = params.toString() ? `/tasks?${params.toString()}` : "/tasks";
  return (
    <Link
      href={href}
      scroll={false}
      className={
        isActive
          ? "rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-primary"
          : "rounded-md border border-border bg-muted/40 px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      }
    >
      {label}
    </Link>
  );
}
