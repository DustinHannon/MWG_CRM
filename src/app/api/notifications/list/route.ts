import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listNotificationsCursor } from "@/lib/notifications-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the /notifications
 * page. Session-authenticated; SESSION-scoped — the handler ignores
 * any client-supplied user id and hard-filters to `ctx.user.id`, so a
 * user can only ever page their OWN bell feed / activity log.
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page (canonical codec).
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "notifications.list", auth: "session" },
  async (req: NextRequest, ctx) => {
    const cursor = req.nextUrl.searchParams.get("cursor");

    const result = await listNotificationsCursor({
      userId: ctx.user.id,
      cursor,
    });

    return NextResponse.json({
      data: result.data.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
      total: result.total,
    });
  },
);
