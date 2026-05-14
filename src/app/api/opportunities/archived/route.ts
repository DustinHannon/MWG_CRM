import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listArchivedOpportunitiesCursor } from "@/lib/opportunities";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list for the admin archived-opportunities
 * page. Admin-only, session-authenticated.
 */
export const GET = withInternalListApi(
  { action: "opportunities.archived.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const result = await listArchivedOpportunitiesCursor({ cursor });
  return NextResponse.json({
    data: result.data.map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: row.stage,
      deletedAt: row.deletedAt,
      reason: row.reason,
      deletedById: row.deletedById,
      deletedByEmail: row.deletedByEmail,
      deletedByName: row.deletedByName,
    })),
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
