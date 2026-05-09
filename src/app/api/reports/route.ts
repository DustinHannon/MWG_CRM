import { NextResponse } from "next/server";
import { db } from "@/db";
import { savedReports } from "@/db/schema/saved-reports";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { reportDefinitionSchema } from "@/lib/reports/request-schemas";
import { isValidField } from "@/lib/reports/schemas";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 11 — POST /api/reports
 *
 * Creates a saved report owned by the current user. Validates entity,
 * field whitelist, group_by length, and metric functions via the
 * shared Zod schema, then performs server-side field validation
 * against `REPORT_ENTITIES` so a forged request can't smuggle a
 * column name that isn't in the whitelist.
 *
 * Returns the created report id on success.
 */
export async function POST(req: Request) {
  const viewer = await requireSession();
  const body = await req.json();
  const result = await withErrorBoundary(
    {
      action: "reports.create",
      userId: viewer.id,
      entityType: "report",
    },
    async () => {
      const input = reportDefinitionSchema.parse(body);

      // Server-side whitelist check: even though the schema accepts any
      // string in `fields` / `groupBy`, those values must be real
      // columns on the chosen entity.
      validateFieldList(input.entityType, input.fields);
      validateFieldList(input.entityType, input.groupBy);
      for (const m of input.metrics) {
        if (m.field && !isValidField(input.entityType, m.field)) {
          throw new Error(`Unknown metric field: ${m.field}`);
        }
      }

      const [row] = await db
        .insert(savedReports)
        .values({
          ownerId: viewer.id,
          name: input.name,
          description: input.description ?? null,
          entityType: input.entityType,
          fields: input.fields,
          filters: input.filters,
          groupBy: input.groupBy,
          metrics: input.metrics,
          visualization: input.visualization,
          isShared: input.isShared,
        })
        .returning({ id: savedReports.id });

      // Phase 15 — coverage sweep. Saved reports can be shared org-wide
      // and embed customer-data filter expressions, so the create row
      // is recorded in the human-actor audit trail (separate from
      // `api_usage_log`, which only tracks API-key traffic).
      await writeAudit({
        actorId: viewer.id,
        action: "reports.create",
        targetType: "report",
        targetId: row.id,
        after: {
          name: input.name,
          entityType: input.entityType,
          isShared: input.isShared,
        },
      });

      return { id: row.id };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result);
}

function validateFieldList(
  entityType: import("@/db/schema/saved-reports").ReportEntityType,
  cols: string[],
) {
  for (const c of cols) {
    if (!isValidField(entityType, c)) {
      throw new Error(`Unknown field: ${c}`);
    }
  }
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
