import { NextResponse, type NextRequest } from "next/server";
import { getPermissions } from "@/lib/auth-helpers";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listMarketingListsCursor } from "@/lib/marketing/lists/cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the marketing lists
 * list client. Session-authenticated (NOT API-key).
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches list name).
 *   ?type              — dynamic | static_imported | all.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "marketing.lists.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingListsView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const typeRaw = sp.get("type");
  const type =
    typeRaw === "dynamic" ||
    typeRaw === "static_imported" ||
    typeRaw === "all"
      ? typeRaw
      : undefined;

  const result = await listMarketingListsCursor({
    filters: {
      search: sp.get("q") || undefined,
      type,
    },
    cursor,
  });

  return NextResponse.json({
    data: result.data,
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
