import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import {
  listApiUsageCursor,
  STATUS_BUCKETS,
  type StatusBucket,
} from "@/lib/api-usage-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/**
 * Internal cursor-paginated list endpoint backing the admin api-usage
 * page. Session-authenticated. Admin-only.
 *
 * Accepts:
 *   ?cursor=<opaque>  — null on first page.
 *   ?q                — search across action / error / key name.
 *   ?method           — exact-match HTTP method.
 *   ?path             — substring path match.
 *   ?status           — comma-separated `2xx,3xx,4xx,5xx` buckets.
 *   ?api_key_id       — comma-separated api_keys.id values.
 *   ?created_at_gte / ?created_at_lte — ISO date or datetime range.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "admin.api_usage.list", auth: "admin" },
  async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  // statuses + api keys arrive as either repeated query params or a
  // single comma-separated string. Normalize both shapes.
  const statusBuckets = parseList(sp.getAll("status"))
    .filter((s): s is StatusBucket =>
      STATUS_BUCKETS.some((b) => b.value === s),
    );
  const apiKeyIds = parseList(sp.getAll("api_key_id"));

  const methodRaw = sp.get("method") || "";
  const method = METHODS.includes(methodRaw) ? methodRaw : undefined;

  const fromRaw = sp.get("created_at_gte");
  const toRaw = sp.get("created_at_lte");
  const fromDate = fromRaw ? new Date(fromRaw) : undefined;
  const isDateOnlyTo = toRaw ? /^\d{4}-\d{2}-\d{2}$/.test(toRaw) : false;
  const toDate = toRaw
    ? isDateOnlyTo
      ? new Date(`${toRaw}T23:59:59.999Z`)
      : new Date(toRaw)
    : undefined;

  const result = await listApiUsageCursor({
    filters: {
      search: sp.get("q")?.trim() || undefined,
      method,
      path: sp.get("path")?.trim() || undefined,
      statusBuckets: statusBuckets.length > 0 ? statusBuckets : undefined,
      apiKeyIds: apiKeyIds.length > 0 ? apiKeyIds : undefined,
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

function parseList(raw: string[]): string[] {
  return raw.flatMap((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
