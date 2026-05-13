import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  CONTACT_COLUMN_KEYS,
  type ContactColumnKey,
  type ContactSortField,
} from "@/lib/contact-view-constants";
import {
  findBuiltinContactView,
  getSavedContactView,
  runContactView,
  type ContactViewDefinition,
} from "@/lib/contact-views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the contacts list
 * client. Session-authenticated (NOT API-key); not surfaced via the
 * public REST surface — the public surface remains `/api/v1/contacts`.
 *
 * Accepts:
 *   ?view=<saved:uuid|builtin:key>     — required; resolved server-side.
 *   ?cursor=<opaque>                   — null on first page.
 *   ?cols=a,b,c                        — active column list (echoed
 *                                        through runContactView).
 *   ?q                                 — search term.
 *   ?owner                             — comma-separated owner ids.
 *   ?account                           — comma-separated account ids.
 *   ?doNotContact / ?doNotEmail /
 *   ?doNotCall / ?doNotMail            — "1" to filter to true.
 *   ?city / ?state / ?country          — string filters.
 *   ?recentlyUpdatedDays               — numeric day-window filter.
 *   ?tag=name1,name2                   — comma-separated tag names.
 *   ?sort / ?dir                       — optional sort override.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<ContactRow>` contract.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  const sp = req.nextUrl.searchParams;
  const viewParam = sp.get("view") ?? "builtin:my-open";

  let activeView: ContactViewDefinition | null = null;
  if (viewParam.startsWith("saved:")) {
    activeView = await getSavedContactView(
      user.id,
      viewParam.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinContactView(viewParam);
    if (activeView?.requiresAllContacts && !canViewAll) {
      activeView = findBuiltinContactView("builtin:my-open");
    }
  }
  if (!activeView) {
    return NextResponse.json({ error: "View not found" }, { status: 404 });
  }

  const ownerRaw = sp.get("owner");
  const accountRaw = sp.get("account");
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
    account: accountRaw
      ? accountRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
    doNotContact: sp.get("doNotContact") === "1" ? true : undefined,
    doNotEmail: sp.get("doNotEmail") === "1" ? true : undefined,
    doNotCall: sp.get("doNotCall") === "1" ? true : undefined,
    doNotMail: sp.get("doNotMail") === "1" ? true : undefined,
    city: sp.get("city") || undefined,
    state: sp.get("state") || undefined,
    country: sp.get("country") || undefined,
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
        .filter((c): c is ContactColumnKey =>
          CONTACT_COLUMN_KEYS.includes(c as ContactColumnKey),
        ) as ContactColumnKey[])
    : null;
  const activeColumns =
    urlCols && urlCols.length > 0 ? urlCols : activeView.columns;

  const sortField = sp.get("sort");
  const sortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const sort = sortField
    ? {
        field: sortField as ContactSortField,
        direction: sortDir as "asc" | "desc",
      }
    : undefined;

  const cursor = sp.get("cursor");
  const pageSize = 50;

  const result = await runContactView({
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
