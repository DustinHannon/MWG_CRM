import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  ACCOUNT_COLUMN_KEYS,
  ACCOUNT_SORT_FIELDS,
  type AccountColumnKey,
  type AccountSortField,
} from "@/lib/account-view-constants";
import {
  findBuiltinAccountView,
  getSavedAccountView,
  runAccountView,
  type AccountViewDefinition,
} from "@/lib/account-views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the accounts list
 * client. Session-authenticated (NOT API-key); not surfaced via the
 * public REST surface — the public surface remains `/api/v1/accounts`.
 *
 * Accepts:
 *   ?view=<saved:uuid|builtin:key>     — required; resolved server-side.
 *   ?cursor=<opaque>                   — null on first page.
 *   ?cols=a,b,c                        — active column list (used by
 *                                        runAccountView only for the
 *                                        returned `columns` echo).
 *   ?q ?owner ?industry                — overlay filters (comma-separated
 *                                        for multi-value owner/industry).
 *   ?recentlyUpdatedDays               — numeric day-window filter.
 *   ?tag=name1,name2                   — comma-separated tag names.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<AccountRow>` contract.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  const sp = req.nextUrl.searchParams;
  const viewParam = sp.get("view") ?? "builtin:my-open";

  let activeView: AccountViewDefinition | null = null;
  if (viewParam.startsWith("saved:")) {
    activeView = await getSavedAccountView(
      user.id,
      viewParam.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinAccountView(viewParam);
    if (activeView?.requiresAllAccounts && !canViewAll) {
      activeView = findBuiltinAccountView("builtin:my-open");
    }
  }
  if (!activeView) {
    return NextResponse.json(
      { error: "View not found" },
      { status: 404 },
    );
  }

  const ownerRaw = sp.get("owner");
  const industryRaw = sp.get("industry");
  const tagRaw = sp.get("tag");
  const recentlyUpdatedRaw = sp.get("recentlyUpdatedDays");

  const extraFilters = {
    search: sp.get("q") || undefined,
    owner: ownerRaw
      ? ownerRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
    industry: industryRaw
      ? industryRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
    recentlyUpdatedDays:
      recentlyUpdatedRaw && Number(recentlyUpdatedRaw) > 0
        ? Number(recentlyUpdatedRaw)
        : undefined,
    tags: tagRaw
      ? tagRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
  };

  const colsParam = sp.get("cols");
  const urlCols = colsParam
    ? (colsParam
        .split(",")
        .filter((c): c is AccountColumnKey =>
          ACCOUNT_COLUMN_KEYS.includes(c as AccountColumnKey),
        ) as AccountColumnKey[])
    : null;
  const activeColumns =
    urlCols && urlCols.length > 0 ? urlCols : activeView.columns;

  const sortFieldRaw = sp.get("sort");
  const sortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const sort =
    sortFieldRaw &&
    (ACCOUNT_SORT_FIELDS as readonly string[]).includes(sortFieldRaw)
      ? {
          field: sortFieldRaw as AccountSortField,
          direction: sortDir as "asc" | "desc",
        }
      : undefined;

  const cursor = sp.get("cursor");
  const pageSize = 50;

  const result = await runAccountView({
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
