import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listAuditLogCursor } from "@/lib/audit-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the admin audit log
 * page. Session-authenticated. Admin-only.
 *
 * Accepts:
 *   ?cursor=<opaque>          — null on first page.
 *   ?q                        — search term across action / target / actor.
 *   ?action                   — exact-match action string.
 *   ?category                 — audit-event category id (prefix group).
 *   ?target_type              — exact-match target_type.
 *   ?request_id               — exact-match request id (cross-line correlation).
 *   ?created_at_gte / ?created_at_lte — ISO timestamps for the createdAt range.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "admin.audit.list", auth: "admin" },
  async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const fromRaw = sp.get("created_at_gte");
  const toRaw = sp.get("created_at_lte");
  const fromDate = fromRaw ? new Date(fromRaw) : undefined;
  // Match the original page: date-only `created_at_lte` resolves to
  // end-of-day so a same-day range includes that day's events.
  const isDateOnlyTo = toRaw ? /^\d{4}-\d{2}-\d{2}$/.test(toRaw) : false;
  const toDate = toRaw
    ? isDateOnlyTo
      ? new Date(`${toRaw}T23:59:59.999Z`)
      : new Date(toRaw)
    : undefined;

  const result = await listAuditLogCursor({
    filters: {
      search: sp.get("q")?.trim() || undefined,
      action: sp.get("action")?.trim() || undefined,
      category: sp.get("category")?.trim() || undefined,
      targetType: sp.get("target_type")?.trim() || undefined,
      requestId: sp.get("request_id")?.trim() || undefined,
      from:
        fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
      to: toDate && !Number.isNaN(toDate.getTime()) ? toDate : undefined,
    },
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
