import { NextResponse, type NextRequest } from "next/server";
import { getPermissions } from "@/lib/auth-helpers";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listMarketingAuditCursor } from "@/lib/marketing/audit-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the marketing audit
 * list client. Session-authenticated (NOT API-key).
 *
 * Always filters to `marketing.*` events.
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches the action string).
 *   ?type              — event prefix (`marketing.X` or `X`).
 *   ?user              — admin-only: scope to actor uuid.
 *   ?from / ?to        — ISO timestamps for the createdAt range.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "marketing.audit.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingAuditView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const fromDate = fromRaw ? new Date(fromRaw) : undefined;
  const toDate = toRaw ? new Date(toRaw) : undefined;

  const result = await listMarketingAuditCursor({
    filters: {
      search: sp.get("q") || undefined,
      type: sp.get("type") || undefined,
      // Admin-only filter scope.
      userId: user.isAdmin ? sp.get("user") || undefined : undefined,
      from: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
      to: toDate && !Number.isNaN(toDate.getTime()) ? toDate : undefined,
    },
    nonAdminUserId: user.isAdmin ? undefined : user.id,
    cursor,
  });

  return NextResponse.json({
    data: result.data,
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
