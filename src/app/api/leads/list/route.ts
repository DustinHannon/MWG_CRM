import { NextResponse, type NextRequest } from "next/server";
import { getPermissions } from "@/lib/auth-helpers";
import { withInternalListApi } from "@/lib/api/internal-list";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import {
  COLUMN_KEYS,
  type ColumnKey,
} from "@/lib/view-constants";
import {
  findBuiltinView,
  getSavedView,
  LEAD_SORT_FIELDS,
  runView,
  type SortField,
  type ViewDefinition,
} from "@/lib/views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the leads list
 * client. Session-authenticated (NOT API-key); not surfaced via the
 * public REST surface — the public surface remains `/api/v1/leads`.
 *
 * Accepts:
 *   ?view=<saved:uuid|builtin:key> — required; resolved server-side.
 *   ?cursor=<opaque>               — null on first page.
 *   ?cols=a,b,c                    — active column list (used by
 *                                    runView only for the returned
 *                                    `columns` echo; the row shape
 *                                    is column-agnostic).
 *   ?q ?status ?rating ?source     — overlay filters.
 *   ?tag=name1,name2               — comma-separated tag names.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<LeadRow>` contract.
 */
export const GET = withInternalListApi(
  { action: "leads.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  const sp = req.nextUrl.searchParams;
  const viewParam = sp.get("view") ?? "builtin:my-open";

  let activeView: ViewDefinition | null = null;
  if (viewParam.startsWith("saved:")) {
    activeView = await getSavedView(user.id, viewParam.slice("saved:".length));
  } else {
    activeView = findBuiltinView(viewParam);
    if (activeView?.requiresAllLeads && !canViewAll) {
      activeView = findBuiltinView("builtin:my-open");
    }
  }
  if (!activeView) {
    return NextResponse.json(
      { error: "View not found" },
      { status: 404 },
    );
  }

  // Runtime allowlist validators — unknown URL inputs are dropped
  // silently rather than 400-ing so stale URLs after enum renames
  // fall back to the view's default filter (matching the tasks
  // route precedent and the `runOpportunityView` defensive filter).
  // Without this guard, a bogus enum value reaches Postgres's
  // `inArray(leads.status, …)` parameter and the lead_status enum
  // rejects with `22P02 invalid input value for enum lead_status`,
  // surfacing as a 500 to the user.
  const enumOne = <T extends readonly string[]>(
    raw: string | null,
    allowed: T,
  ): T[number] | undefined =>
    raw && (allowed as readonly string[]).includes(raw)
      ? (raw as T[number])
      : undefined;

  const statusValid = enumOne(sp.get("status"), LEAD_STATUSES);
  const ratingValid = enumOne(sp.get("rating"), LEAD_RATINGS);
  const sourceValid = enumOne(sp.get("source"), LEAD_SOURCES);

  const extraFilters = {
    search: sp.get("q") || undefined,
    status: statusValid ? [statusValid] : undefined,
    rating: ratingValid ? [ratingValid] : undefined,
    source: sourceValid ? [sourceValid] : undefined,
    tags: sp.get("tag")
      ? sp
          .get("tag")!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
  };

  const colsParam = sp.get("cols");
  const urlCols = colsParam
    ? (colsParam
        .split(",")
        .filter((c): c is ColumnKey =>
          COLUMN_KEYS.includes(c as ColumnKey),
        ) as ColumnKey[])
    : null;
  const activeColumns = urlCols && urlCols.length > 0 ? urlCols : activeView.columns;

  // Validate sort field against the lead sort allowlist before
  // forwarding to runView. Unknown values silently fall back to the
  // view's default sort rather than 400-ing — matches the lenient
  // behavior of the public REST surface.
  const sortFieldRaw = sp.get("sort");
  const sortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const sort =
    sortFieldRaw &&
    (LEAD_SORT_FIELDS as readonly string[]).includes(sortFieldRaw)
      ? {
          field: sortFieldRaw as SortField,
          direction: sortDir as "asc" | "desc",
        }
      : undefined;

  const cursor = sp.get("cursor");
  const pageSize = 50;

  const result = await runView({
    view: activeView,
    user,
    canViewAll,
    page: 1,
    pageSize,
    columns: activeColumns,
    sort,
    extraFilters,
    cursor,
  });

  return NextResponse.json({
    data: result.rows,
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
