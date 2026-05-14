import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listImportRunsCursor } from "@/lib/d365/import-runs-cursor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list endpoint backing the admin d365-import
 * runs table. Session-authenticated. Admin-only.
 *
 * Accepts:
 *   ?cursor=<opaque>  — null on first page.
 *   ?status           — exact-match run status.
 *   ?entity           — exact-match entity type.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "admin.d365_import.list", auth: "admin" },
  async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;

  const result = await listImportRunsCursor({
    filters: {
      status: sp.get("status") || undefined,
      entity: sp.get("entity") || undefined,
    },
    cursor: sp.get("cursor"),
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
