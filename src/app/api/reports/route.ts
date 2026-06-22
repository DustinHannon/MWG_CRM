import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  MARKETING_REPORT_ENTITY_TYPES,
  savedReports,
} from "@/db/schema/saved-reports";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { reportDefinitionSchema } from "@/lib/reports/request-schemas";
import { isValidField } from "@/lib/reports/schemas";
import { rateLimit } from "@/lib/security/rate-limit";
import { requireSameOrigin } from "@/lib/security/same-origin";
import { withErrorBoundary } from "@/lib/server-action";
import { ForbiddenError, RateLimitError, ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Report definitions are small; reject anything larger than this before
 * parsing so a hostile client can't drive an unbounded JSON parse.
 */
const MAX_BODY_BYTES = 16 * 1024;

async function readReportBody(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    throw new ValidationError("Request body too large.");
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ValidationError("Request body too large.");
  }
  try {
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

/**
 * POST /api/reports
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
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const viewer = await requireSession();
  const result = await withErrorBoundary(
    {
      action: "reports.create",
      userId: viewer.id,
      entityType: "report",
    },
    async () => {
      // Per-user throttle on the report write path (shares the report
      // builder's preview bucket — both are session-user report
      // operations).
      const rl = await rateLimit(
        { kind: "filter_preview", principal: viewer.id },
        env.RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE,
        60,
      );
      if (!rl.allowed) {
        throw new RateLimitError(
          `Too many requests. Retry in ${rl.retryAfter ?? 60}s.`,
        );
      }

      const body = await readReportBody(req);
      const input = reportDefinitionSchema.parse(body);

      // Marketing-entity reports may only be authored by admins or users
      // with the marketing-reports permission — the same gate the
      // view/edit paths apply. Without this a non-marketing user could
      // create (and share) a marketing-typed report definition.
      if (
        (MARKETING_REPORT_ENTITY_TYPES as readonly string[]).includes(
          input.entityType,
        )
      ) {
        const perms = await getPermissions(viewer.id);
        if (!viewer.isAdmin && perms.canMarketingReportsView !== true) {
          throw new ForbiddenError(
            "Marketing reports require admin or marketing manager role.",
          );
        }
      }

      // Server-side whitelist check: even though the schema accepts any
      // string in `fields` / `groupBy`, those values must be real
      // columns on the chosen entity.
      validateFieldList(input.entityType, input.fields);
      validateFieldList(input.entityType, input.groupBy);
      for (const m of input.metrics) {
        if (m.field && !isValidField(input.entityType, m.field)) {
          throw new ValidationError(`Unknown metric field: ${m.field}`);
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

      // coverage sweep. Saved reports can be shared org-wide
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
      throw new ValidationError(`Unknown field: ${c}`);
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
