import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { executeReport } from "@/lib/reports/access";
import { getReportByIdOrThrow } from "@/lib/reports/repository";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireSameOrigin } from "@/lib/security/same-origin";
import { withErrorBoundary } from "@/lib/server-action";
import { RateLimitError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/reports/[id]/run
 *
 * Executes a saved report against the viewer's scope. Returns
 * `{ rows, columns, totalCount }`. Used by the runner page when the
 * user clicks "Refresh" or by other clients that want JSON output.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

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
      // Per-user throttle: run executes a fresh dynamic aggregation/scan
      // (up to MAX_ROWS) against the shared session pooler, the most
      // DB-expensive report op. Reuse the report builder's preview bucket
      // (preview/create do the same) so an unthrottled caller can't loop
      // expensive runs against any builtin/shared report.
      const rl = await rateLimit(
        { kind: "filter_preview", principal: viewer.id },
        env.RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE,
        60,
      );
      if (!rl.allowed) {
        throw new RateLimitError(
          `Too many report runs. Retry in ${rl.retryAfter ?? 60}s.`,
        );
      }

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
    case "RATE_LIMIT":
      return 429;
    default:
      return 500;
  }
}
