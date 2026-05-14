import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listArchivedTasksCursor } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list for the admin archived-tasks page.
 * Admin-only, session-authenticated.
 */
export const GET = withInternalListApi(
  { action: "tasks.archived.list", auth: "admin" },
  async (req: NextRequest) => {
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const result = await listArchivedTasksCursor({ cursor });
  return NextResponse.json({
    data: result.data.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: null,
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
