import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  OPPORTUNITY_COLUMN_KEYS,
  OPPORTUNITY_SORT_FIELDS,
  type OpportunityColumnKey,
  type OpportunitySortField,
} from "@/lib/opportunity-view-constants";
import {
  findBuiltinOpportunityView,
  getSavedOpportunityView,
  runOpportunityView,
  type OpportunityViewDefinition,
} from "@/lib/opportunity-views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the opportunities
 * list client. Session-authenticated (NOT API-key); not surfaced via
 * the public REST surface — the public surface remains
 * `/api/v1/opportunities`.
 *
 * Accepts:
 *   ?view=<saved:uuid|builtin:key>     — required; resolved server-side.
 *   ?cursor=<opaque>                   — null on first page.
 *   ?cols=a,b,c                        — active column list (echoed
 *                                        through runOpportunityView).
 *   ?q                                 — search term.
 *   ?owner                             — comma-separated owner ids.
 *   ?account                           — comma-separated account ids.
 *   ?stage                             — single stage key
 *                                        (prospecting | qualification |
 *                                        proposal | negotiation |
 *                                        closed_won | closed_lost).
 *   ?closingWithinDays                 — numeric day-window filter.
 *   ?minAmount / ?maxAmount            — numeric amount-range filters.
 *   ?tag=name1,name2                   — comma-separated tag names.
 *   ?sort / ?dir                       — optional sort override.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<OpportunityRow>` contract.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  const sp = req.nextUrl.searchParams;
  const viewParam = sp.get("view") ?? "builtin:my-open";

  let activeView: OpportunityViewDefinition | null = null;
  if (viewParam.startsWith("saved:")) {
    activeView = await getSavedOpportunityView(
      user.id,
      viewParam.slice("saved:".length),
    );
  } else {
    activeView = findBuiltinOpportunityView(viewParam);
    if (activeView?.requiresAllOpportunities && !canViewAll) {
      activeView = findBuiltinOpportunityView("builtin:my-open");
    }
  }
  if (!activeView) {
    return NextResponse.json({ error: "View not found" }, { status: 404 });
  }

  const ownerRaw = sp.get("owner");
  const accountRaw = sp.get("account");
  const stageRaw = sp.get("stage");
  const tagRaw = sp.get("tag");
  const closingWithinRaw = sp.get("closingWithinDays");
  const minAmountRaw = sp.get("minAmount");
  const maxAmountRaw = sp.get("maxAmount");

  // Numeric range parser — empty string and non-finite parse results
  // collapse to undefined ("no filter"). parseFloat tolerates strings
  // like "1500.50" and is safe against NaN via Number.isFinite below.
  const parseNumeric = (raw: string | null): number | undefined => {
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

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
    stage: stageRaw
      ? stageRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
    closingWithinDays:
      closingWithinRaw && Number(closingWithinRaw) > 0
        ? Number(closingWithinRaw)
        : undefined,
    minAmount: parseNumeric(minAmountRaw),
    maxAmount: parseNumeric(maxAmountRaw),
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
        .filter((c): c is OpportunityColumnKey =>
          OPPORTUNITY_COLUMN_KEYS.includes(c as OpportunityColumnKey),
        ) as OpportunityColumnKey[])
    : null;
  const activeColumns =
    urlCols && urlCols.length > 0 ? urlCols : activeView.columns;

  const sortFieldRaw = sp.get("sort");
  const sortDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const sort =
    sortFieldRaw &&
    (OPPORTUNITY_SORT_FIELDS as readonly string[]).includes(sortFieldRaw)
      ? {
          field: sortFieldRaw as OpportunitySortField,
          direction: sortDir as "asc" | "desc",
        }
      : undefined;

  const cursor = sp.get("cursor");
  const pageSize = 50;

  const result = await runOpportunityView({
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
