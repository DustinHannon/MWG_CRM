import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { getPermissions } from "@/lib/auth-helpers";
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

  // Defense-in-depth marketing gate, matching the built-in filter in
  // reports/page.tsx. Marketing-entity reports are gated to admins +
  // canMarketingReportsView per src/lib/reports/access.ts; execution
  // already 403s on click via assertCanViewReport. Pass the gate into the
  // cursor query so marketing reports are excluded from the rows AND the
  // total/nextCursor for a non-permitted viewer (not just post-filtered).
  const canSeeMarketing =
    user.isAdmin || (await getPermissions(user.id)).canMarketingReportsView === true;

  const result = await listReportsCursor({
    viewerId: user.id,
    filters: {
      search: sp.get("q")?.trim() || undefined,
      scope,
    },
    cursor: sp.get("cursor"),
    canSeeMarketing,
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
