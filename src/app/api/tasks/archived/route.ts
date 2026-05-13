import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { listArchivedTasksCursor } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list for the admin archived-tasks page.
 * Admin-only, session-authenticated.
 */
export async function GET(req: Request) {
  const user = await requireSession();
  if (!user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
}
