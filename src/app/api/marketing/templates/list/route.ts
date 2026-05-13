import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listTemplatesCursor } from "@/lib/marketing/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the marketing
 * templates list client. Session-authenticated (NOT API-key); not
 * surfaced via the public REST surface.
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches name/subject).
 *   ?status            — draft | ready | archived | all.
 *   ?scope             — global | personal | all.
 *
 * Returns `{ data, nextCursor, total }` matching the
 * `StandardListPagePage<MarketingTemplateRow>` contract.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingTemplatesView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const statusRaw = sp.get("status");
  const status =
    statusRaw === "draft" ||
    statusRaw === "ready" ||
    statusRaw === "archived" ||
    statusRaw === "all"
      ? statusRaw
      : undefined;

  const scopeRaw = sp.get("scope");
  const scope =
    scopeRaw === "global" || scopeRaw === "personal" || scopeRaw === "all"
      ? scopeRaw
      : undefined;

  const result = await listTemplatesCursor({
    userId: user.id,
    isAdmin: user.isAdmin,
    filters: {
      search: sp.get("q") || undefined,
      status,
      scope,
    },
    cursor,
  });

  return NextResponse.json({
    data: result.data,
    nextCursor: result.nextCursor,
    total: result.total,
  });
}
