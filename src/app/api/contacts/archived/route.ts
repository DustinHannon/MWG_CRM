import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listArchivedContactsCursor } from "@/lib/contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list for the admin archived-contacts page.
 * Admin-only, session-authenticated.
 */
export const GET = withInternalListApi(
  { action: "contacts.archived.list", auth: "admin" },
  async (req: NextRequest) => {
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const result = await listArchivedContactsCursor({ cursor });
  return NextResponse.json({
    data: result.data.map((row) => ({
      id: row.id,
      title:
        [row.firstName, row.lastName].filter(Boolean).join(" ") ||
        row.email ||
        "(Unnamed contact)",
      subtitle: row.email,
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
