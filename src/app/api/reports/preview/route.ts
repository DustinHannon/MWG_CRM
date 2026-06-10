import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { executeReport } from "@/lib/reports/access";
import { reportDefinitionSchema } from "@/lib/reports/request-schemas";
import { isValidField } from "@/lib/reports/schemas";
import { rateLimit } from "@/lib/security/rate-limit";
import { withErrorBoundary } from "@/lib/server-action";
import { RateLimitError, ValidationError } from "@/lib/errors";
import type { SavedReport } from "@/db/schema/saved-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Report definitions are small (a name, a handful of field/group/metric
 * names, a filter object). Reject anything larger than this before
 * parsing so a hostile client can't drive an unbounded JSON parse.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Parse a request JSON body with a Content-Length cap. Throws a
 * ValidationError on an oversized or unparseable body so the error
 * boundary returns the standard 400 envelope instead of an unhandled
 * 500. Kept local to the report routes (small, route-specific guard);
 * the schema's bounded fields do the rest of the size limiting.
 */
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
 * POST /api/reports/preview
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

  const result = await withErrorBoundary(
    {
      action: "reports.preview",
      userId: viewer.id,
      entityType: "report",
    },
    async () => {
      // Per-user throttle: the builder fires preview on every (debounced)
      // edit, and each call runs a fresh dynamic aggregation, so an
      // unthrottled caller could hammer the shared DB.
      const rl = await rateLimit(
        { kind: "filter_preview", principal: viewer.id },
        env.RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE,
        60,
      );
      if (!rl.allowed) {
        throw new RateLimitError(
          `Too many preview requests. Retry in ${rl.retryAfter ?? 60}s.`,
        );
      }

      const body = await readReportBody(req);
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
    case "RATE_LIMIT":
      return 429;
    case "REAUTH_REQUIRED":
      return 401;
    default:
      return 500;
  }
}
