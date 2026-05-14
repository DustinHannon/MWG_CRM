import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import {
  FAILURE_STATUSES,
  listEmailFailuresCursor,
  type FailureStatus,
} from "@/lib/email-failures-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGE_VALUES = ["24h", "7d", "30d", "90d"] as const;
type RangeValue = (typeof RANGE_VALUES)[number];

const RANGE_MS: Record<RangeValue, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

/**
 * Internal cursor-paginated list endpoint backing the admin email
 * failures page. Session-authenticated. Admin-only.
 *
 * Always restricts to failure-shaped rows (status IN failed,
 * blocked_preflight). Successful sends and blocked_e2e are
 * intentionally excluded — see the email send log for the full feed.
 *
 * Accepts:
 *   ?cursor=<opaque>  — null on first page.
 *   ?from             — range bucket: 24h | 7d | 30d | 90d (default 7d).
 *   ?status           — all | failed | blocked_preflight (default all).
 *   ?feature          — exact-match feature.
 *   ?errorCode        — exact-match error code.
 *   ?fromUser         — uuid of the sender.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "admin.email_failures.list", auth: "admin" },
  async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const rangeRaw = sp.get("from");
  const range: RangeValue = (RANGE_VALUES as readonly string[]).includes(
    rangeRaw ?? "",
  )
    ? (rangeRaw as RangeValue)
    : "7d";
  const since = new Date(Date.now() - RANGE_MS[range]);

  const statusRaw = sp.get("status");
  let status: FailureStatus | "all" = "all";
  if (statusRaw === "all") {
    status = "all";
  } else if (
    statusRaw &&
    (FAILURE_STATUSES as readonly string[]).includes(statusRaw)
  ) {
    status = statusRaw as FailureStatus;
  }

  const fromUserRaw = sp.get("fromUser")?.trim();
  const fromUserId =
    fromUserRaw && /^[0-9a-f-]{36}$/i.test(fromUserRaw)
      ? fromUserRaw
      : undefined;

  const result = await listEmailFailuresCursor({
    filters: {
      status,
      since,
      feature: sp.get("feature")?.trim() || undefined,
      errorCode: sp.get("errorCode")?.trim() || undefined,
      fromUserId,
    },
    cursor,
  });

  return NextResponse.json({
    data: result.data.map((r) => ({
      ...r,
      queuedAt: r.queuedAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    })),
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
