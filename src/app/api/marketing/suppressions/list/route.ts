import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  listSuppressionsCursor,
  SUPPRESSION_TYPES,
  type SuppressionType,
} from "@/lib/marketing/suppressions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the marketing
 * suppressions list client. Session-authenticated (NOT API-key).
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches email).
 *   ?source            — unsubscribe | group_unsubscribe | bounce |
 *                        block | spamreport | invalid | manual | all.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingSuppressionsView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const sourceRaw = sp.get("source");
  let source: SuppressionType | "all" | undefined;
  if (sourceRaw === "all") {
    source = "all";
  } else if (
    sourceRaw &&
    SUPPRESSION_TYPES.includes(sourceRaw as SuppressionType)
  ) {
    source = sourceRaw as SuppressionType;
  }

  const result = await listSuppressionsCursor({
    filters: {
      search: sp.get("q") || undefined,
      source,
    },
    cursor,
  });

  return NextResponse.json({
    data: result.data,
    nextCursor: result.nextCursor,
    total: result.total,
  });
}
