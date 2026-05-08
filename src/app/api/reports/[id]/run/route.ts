import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { executeReport } from "@/lib/reports/access";
import { getReportByIdOrThrow } from "@/lib/reports/repository";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 11 — POST /api/reports/[id]/run
 *
 * Executes a saved report against the viewer's scope. Returns
 * `{ rows, columns, totalCount }`. Used by the runner page when the
 * user clicks "Refresh" or by other clients that want JSON output.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await requireSession();
  const { id } = await params;

  const result = await withErrorBoundary(
    {
      action: "reports.run",
      userId: viewer.id,
      entityType: "report",
      entityId: id,
    },
    async () => {
      const report = await getReportByIdOrThrow(id);
      const out = await executeReport(report, viewer);
      return out;
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result);
}

function statusFor(code: string): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}
