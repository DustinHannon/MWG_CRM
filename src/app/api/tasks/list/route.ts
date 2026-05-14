import { NextResponse, type NextRequest } from "next/server";
import { getPermissions } from "@/lib/auth-helpers";
import { withInternalListApi } from "@/lib/api/internal-list";
import {
  TASK_COLUMN_KEYS,
  type TaskColumnKey,
} from "@/lib/task-view-constants";
import {
  findBuiltinTaskView,
  getSavedTaskView,
  TASK_ASSIGNEE_PRESETS,
  TASK_DUE_RANGE_OPTS,
  TASK_PRIORITY_OPTS,
  TASK_RELATED_ENTITY_OPTS,
  TASK_RELATION_OPTS,
  TASK_SORT_FIELDS,
  TASK_STATUS_OPTS,
  type TaskSortField,
  type TaskViewDefinition,
  type TaskViewFilters,
  type TaskViewSort,
} from "@/lib/task-views";
import { listTasksForUser } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the tasks list
 * client. Session-authenticated (NOT API-key); not surfaced via the
 * public REST surface — the public surface remains `/api/v1/tasks`.
 *
 * Accepts:
 *   ?view=<saved:uuid|builtin:key>     — required; resolved server-side.
 *   ?cursor=<opaque>                   — null on first page.
 *   ?cols=a,b,c                        — active column list (echoed back
 *                                        for parity; the lib helper
 *                                        does not gate on columns).
 *   ?q                                 — title-substring search.
 *   ?assignee=me|any|<userId>          — assignee filter.
 *   ?status=open,in_progress,…         — multi-select.
 *   ?priority=low,normal,high,urgent   — multi-select.
 *   ?relation=all|standalone|linked    — relation filter.
 *   ?related=lead|account|contact|opportunity
 *                                      — entity-type filter (only
 *                                        meaningful when relation
 *                                        unset / 'linked').
 *   ?due=overdue|today|this_week|later|none|all
 *                                      — due-window filter.
 *   ?tag=name1,name2                   — comma-separated tag names.
 *   ?sort / ?dir                       — optional sort override.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<TaskRow>` contract.
 *
 * Pagination behaviour:
 *   - Tasks always use `listTasksForUser` (which supports all 6 sort
 *     fields plus all 11 filter dimensions). When the default sort
 *     `(dueAt, asc)` is active, cursor pagination flows naturally
 *     through the `(due_at NULLS LAST, id DESC)` composite index.
 *   - For non-default sorts, `listTasksForUser` returns `nextCursor:
 *     null` after the first page because cursor seek is only valid
 *     against the default sort. The shell still shows the first 50
 *     rows correctly; load-more is hidden by the null cursor. This
 *     is documented divergence from the other P0 entities (which
 *     use cursor for any sort because their lib helpers maintain
 *     per-sort cursor encodings).
 */
export const GET = withInternalListApi(
  { action: "tasks.list", auth: "session" },
  async (req: NextRequest, { user: session }) => {
  const perms = await getPermissions(session.id);
  const canViewOthers = session.isAdmin || perms.canViewOthersTasks;

  const sp = req.nextUrl.searchParams;
  const viewParam = sp.get("view") ?? "builtin:my-open";

  let activeView: TaskViewDefinition | null = null;
  if (viewParam.startsWith("saved:")) {
    activeView = await getSavedTaskView(
      session.id,
      viewParam.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinTaskView(viewParam);
    if (activeView?.id === "builtin:team-open" && !canViewOthers) {
      activeView = findBuiltinTaskView("builtin:my-open");
    }
  }
  if (!activeView) {
    return NextResponse.json({ error: "View not found" }, { status: 404 });
  }

  // Parse overlay filters. Empty / missing collapses to the view's
  // own filter values via the spread below.
  const qRaw = sp.get("q");
  const assigneeRaw = sp.get("assignee");
  const statusRaw = sp.get("status");
  const priorityRaw = sp.get("priority");
  const relationRaw = sp.get("relation");
  const relatedRaw = sp.get("related");
  const dueRaw = sp.get("due");
  const tagRaw = sp.get("tag");

  const splitCsv = (s: string | null): string[] | undefined =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.length > 0)
      : undefined;

  // Runtime allowlist validators — unknown URL inputs are dropped
  // (the view default for that field then wins via the spread below)
  // so a malicious or stale URL can't push raw strings into
  // TaskViewFilters via a type-erase cast.
  const filterEnum = <T extends readonly string[]>(
    raw: string | null,
    allowed: T,
  ): T[number] | undefined =>
    raw && (allowed as readonly string[]).includes(raw)
      ? (raw as T[number])
      : undefined;
  const filterEnumList = <T extends readonly string[]>(
    raw: string | null,
    allowed: T,
  ): T[number][] | undefined => {
    const parts = splitCsv(raw);
    if (!parts) return undefined;
    const filtered = parts.filter((v): v is T[number] =>
      (allowed as readonly string[]).includes(v),
    );
    return filtered.length > 0 ? filtered : undefined;
  };
  const assignee =
    assigneeRaw &&
    ((TASK_ASSIGNEE_PRESETS as readonly string[]).includes(assigneeRaw) ||
      /^[a-zA-Z0-9-]+$/.test(assigneeRaw))
      ? (assigneeRaw as TaskViewFilters["assignee"])
      : undefined;
  const statusList = filterEnumList(statusRaw, TASK_STATUS_OPTS);
  const priorityList = filterEnumList(priorityRaw, TASK_PRIORITY_OPTS);
  const relation = filterEnum(relationRaw, TASK_RELATION_OPTS);
  const relatedEntity = filterEnum(relatedRaw, TASK_RELATED_ENTITY_OPTS);
  const dueRange = filterEnum(dueRaw, TASK_DUE_RANGE_OPTS);

  const overlay: Partial<TaskViewFilters> = {
    ...(qRaw ? { q: qRaw } : {}),
    ...(assignee ? { assignee } : {}),
    ...(statusList ? { status: statusList } : {}),
    ...(priorityList ? { priority: priorityList } : {}),
    ...(relation ? { relation } : {}),
    ...(relatedEntity ? { relatedEntity } : {}),
    ...(dueRange ? { dueRange } : {}),
    ...(tagRaw ? { tags: splitCsv(tagRaw) } : {}),
  };

  // View defaults + URL overlay.
  const filters: TaskViewFilters = { ...activeView.filters, ...overlay };

  // Echo back the resolved column list so the client side can drop
  // columns from the rendered row without a second pass. Currently
  // not used by listTasksForUser; included for future parity with
  // the other P0 routes.
  const colsParam = sp.get("cols");
  const urlCols = colsParam
    ? (colsParam
        .split(",")
        .filter((c): c is TaskColumnKey =>
          TASK_COLUMN_KEYS.includes(c as TaskColumnKey),
        ) as TaskColumnKey[])
    : null;
  void urlCols; // resolution happens server-side; not needed by the
  // list helper.

  // Validate sort field against the task sort allowlist. Unknown
  // values silently fall back to the view's default sort rather than
  // 400-ing — matches the lenient public REST behavior.
  const sortFieldRaw = sp.get("sort");
  const sortDirRaw = sp.get("dir");
  const sortFieldOk =
    sortFieldRaw !== null &&
    (TASK_SORT_FIELDS as readonly string[]).includes(sortFieldRaw);
  const sort: TaskViewSort =
    sortFieldOk && sortDirRaw === "asc"
      ? { field: sortFieldRaw as TaskSortField, direction: "asc" }
      : sortFieldOk && sortDirRaw === "desc"
        ? { field: sortFieldRaw as TaskSortField, direction: "desc" }
        : activeView.sort;

  // Permission-gated team view; honour the override here too in
  // case a stale URL kept the team-view id after a perm change.
  if (filters.assignee === "any" && !canViewOthers) {
    filters.assignee = "me";
  }

  const cursor = sp.get("cursor");
  const pageSize = 50;

  const { rows, nextCursor, total } = await listTasksForUser({
    userId: session.id,
    isAdmin: session.isAdmin,
    assignee: filters.assignee,
    status: filters.status,
    priority: filters.priority,
    relation: filters.relation,
    relatedEntity: filters.relatedEntity,
    dueRange: filters.dueRange,
    q: filters.q,
    tags: filters.tags,
    sort,
    cursor,
    pageSize,
    withCount: true,
  });

  return NextResponse.json({
    data: rows,
    nextCursor,
    total: total ?? rows.length,
  });
  },
);
