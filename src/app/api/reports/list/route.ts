import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listReportsCursor } from "@/lib/reports/cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the /reports
 * user-and-shared section. Session-authenticated (any user, no admin
 * gate — the cursor function scopes to viewer-visible rows).
 *
 * Accepts:
 *   ?cursor=<opaque>  — null on first page.
 *   ?q                — search across name / description.
 *   ?scope            — all | mine | shared.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "reports.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  const sp = req.nextUrl.searchParams;

  const scopeRaw = sp.get("scope");
  const scope: "all" | "mine" | "shared" =
    scopeRaw === "mine" || scopeRaw === "shared" ? scopeRaw : "all";

  const result = await listReportsCursor({
    viewerId: user.id,
    filters: {
      search: sp.get("q")?.trim() || undefined,
      scope,
    },
    cursor: sp.get("cursor"),
  });

  return NextResponse.json({
    data: result.data.map((r) => ({
      ...r,
      updatedAt: r.updatedAt.toISOString(),
    })),
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
