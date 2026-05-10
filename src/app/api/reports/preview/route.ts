import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { executeReport } from "@/lib/reports/access";
import { reportDefinitionSchema } from "@/lib/reports/request-schemas";
import { isValidField } from "@/lib/reports/schemas";
import { withErrorBoundary } from "@/lib/server-action";
import { ValidationError } from "@/lib/errors";
import type { SavedReport } from "@/db/schema/saved-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 11 — POST /api/reports/preview
 *
 * Accepts an *unsaved* report definition (same shape as create) and
 * returns the rows that would be produced if it were saved and run.
 * Backed by the same `executeReport` helper to guarantee consistency
 * between the live builder preview and the saved-report runner.
 *
 * The viewer is the report's pseudo-owner for the duration of the
 * preview — `executeReport` then narrows the result set back to the
 * viewer's own scope. So a non-admin previewing an admin's filter
 * doesn't suddenly see every row.
 */
export async function POST(req: Request) {
  const viewer = await requireSession();
  const body = await req.json();

  const result = await withErrorBoundary(
    {
      action: "reports.preview",
      userId: viewer.id,
      entityType: "report",
    },
    async () => {
      const input = reportDefinitionSchema.parse(body);

      // Field whitelist re-check.
      for (const c of input.fields) {
        if (!isValidField(input.entityType, c)) {
          throw new ValidationError(`Unknown field: ${c}`);
        }
      }
      for (const c of input.groupBy) {
        if (!isValidField(input.entityType, c)) {
          throw new ValidationError(`Unknown field: ${c}`);
        }
      }
      for (const m of input.metrics) {
        if (m.field && !isValidField(input.entityType, m.field)) {
          throw new ValidationError(`Unknown metric field: ${m.field}`);
        }
      }

      // Build an in-memory SavedReport-shaped object for executeReport.
      const ephemeral: SavedReport = {
        id: "preview",
        ownerId: viewer.id,
        name: input.name || "Preview",
        description: input.description ?? null,
        entityType: input.entityType,
        fields: input.fields,
        filters: input.filters,
        groupBy: input.groupBy,
        metrics: input.metrics,
        visualization: input.visualization,
        isShared: false,
        isBuiltin: false,
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return executeReport(ephemeral, viewer, { preview: true });
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
