import { NextResponse, type NextRequest } from "next/server";
import { withInternalListApi } from "@/lib/api/internal-list";
import { listArchivedLeadsCursor } from "@/lib/leads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal cursor-paginated list for the admin archived-leads page.
 * Admin-only. Session-authenticated (not API-key); not surfaced via
 * the public REST surface.
 *
 * Emits the normalised `ArchivedRow` envelope consumed by
 * `ArchivedListClient` — title + subtitle + the 5 audit columns.
 */
export const GET = withInternalListApi(
  { action: "leads.archived.list", auth: "admin" },
  async (req: NextRequest) => {
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const result = await listArchivedLeadsCursor({ cursor });
  return NextResponse.json({
    data: result.data.map((row) => ({
      id: row.id,
      title:
        [row.firstName, row.lastName].filter(Boolean).join(" ") ||
        row.companyName ||
        "(Unnamed lead)",
      subtitle: row.companyName,
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
