import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { savedReports } from "@/db/schema/saved-reports";
import { requireSession } from "@/lib/auth-helpers";
import {
  assertCanDeleteReport,
  assertCanEditReport,
} from "@/lib/reports/access";
import { getReportByIdOrThrow } from "@/lib/reports/repository";
import { reportUpdateSchema } from "@/lib/reports/request-schemas";
import { isValidField } from "@/lib/reports/schemas";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 11 — PATCH /api/reports/[id]
 *
 * Owner-or-admin update path. Bumps the `version` column on every
 * change so the builder can detect stale state if we ever add
 * concurrent editing.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await requireSession();
  const { id } = await params;
  const body = await req.json();

  const result = await withErrorBoundary(
    {
      action: "reports.update",
      userId: viewer.id,
      entityType: "report",
      entityId: id,
    },
    async () => {
      const report = await getReportByIdOrThrow(id);
      await assertCanEditReport(report, viewer);

      const input = reportUpdateSchema.parse(body);
      const entityType = (input.entityType ?? report.entityType) as import(
        "@/db/schema/saved-reports"
      ).ReportEntityType;

      if (input.fields) {
        for (const c of input.fields) {
          if (!isValidField(entityType, c)) {
            throw new Error(`Unknown field: ${c}`);
          }
        }
      }
      if (input.groupBy) {
        for (const c of input.groupBy) {
          if (!isValidField(entityType, c)) {
            throw new Error(`Unknown field: ${c}`);
          }
        }
      }
      if (input.metrics) {
        for (const m of input.metrics) {
          if (m.field && !isValidField(entityType, m.field)) {
            throw new Error(`Unknown metric field: ${m.field}`);
          }
        }
      }

      await db
        .update(savedReports)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description ?? null }
            : {}),
          ...(input.entityType !== undefined
            ? { entityType: input.entityType }
            : {}),
          ...(input.fields !== undefined ? { fields: input.fields } : {}),
          ...(input.filters !== undefined ? { filters: input.filters } : {}),
          ...(input.groupBy !== undefined ? { groupBy: input.groupBy } : {}),
          ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
          ...(input.visualization !== undefined
            ? { visualization: input.visualization }
            : {}),
          ...(input.isShared !== undefined ? { isShared: input.isShared } : {}),
          updatedAt: sql`now()`,
          version: sql`${savedReports.version} + 1`,
        })
        .where(eq(savedReports.id, id));

      return { id };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result);
}

/**
 * DELETE /api/reports/[id] — soft delete. Built-in reports cannot be
 * deleted (the helper throws ForbiddenError). Body may include
 * `{ reason?: string }`.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await requireSession();
  const { id } = await params;

  const reason: string | undefined = await req
    .json()
    .then((b) => (typeof b?.reason === "string" ? b.reason : undefined))
    .catch(() => undefined);

  const result = await withErrorBoundary(
    {
      action: "reports.delete",
      userId: viewer.id,
      entityType: "report",
      entityId: id,
    },
    async () => {
      const report = await getReportByIdOrThrow(id);
      await assertCanDeleteReport(report, viewer);

      await db
        .update(savedReports)
        .set({
          isDeleted: true,
          deletedAt: sql`now()`,
          deletedById: viewer.id,
          deleteReason: reason ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(savedReports.id, id));

      return { id };
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
    case "CONFLICT":
      return 409;
    case "RATE_LIMIT":
      return 429;
    case "REAUTH_REQUIRED":
      return 401;
    default:
      return 500;
  }
}
