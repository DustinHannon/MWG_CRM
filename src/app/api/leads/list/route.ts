import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  COLUMN_KEYS,
  type ColumnKey,
} from "@/lib/view-constants";
import {
  findBuiltinView,
  getSavedView,
  runView,
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
export async function GET(req: NextRequest) {
  const user = await requireSession();
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

  const extraFilters = {
    search: sp.get("q") || undefined,
    status: sp.get("status") ? [sp.get("status") as string] : undefined,
    rating: sp.get("rating") ? [sp.get("rating") as string] : undefined,
    source: sp.get("source") ? [sp.get("source") as string] : undefined,
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

  const sortField = sp.get("sort");
  const sortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const sort = sortField
    ? {
        field: sortField as never,
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
}
