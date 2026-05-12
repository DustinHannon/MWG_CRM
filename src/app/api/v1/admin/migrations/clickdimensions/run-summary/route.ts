import { z } from "zod";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { sessionFromKey } from "@/lib/api/v1/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Records that an extraction run has completed.
 *
 * Audit row carries the success/failure breakdown. The worklist UI
 * surfaces the latest `run_completed` event detail as a header banner.
 */

const RunSummaryPayload = z.object({
  runId: z.string().min(1).max(128),
  total: z.number().int().min(0),
  success: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0),
  reason: z
    .enum(["completed", "limit_reached", "session_expired", "aborted"])
    .default("completed"),
});

export const POST = withApi(
  {
    scope: "marketing.migrations.api",
    action: "marketing.migration.run.completed",
  },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = RunSummaryPayload.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid payload", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const user = await sessionFromKey(key);
    await writeAudit({
      actorId: user.id,
      action: MARKETING_AUDIT_EVENTS.MIGRATION_RUN_COMPLETED,
      targetType: "clickdimensions_migration",
      targetId: parsed.data.runId,
      after: {
        runId: parsed.data.runId,
        total: parsed.data.total,
        success: parsed.data.success,
        failed: parsed.data.failed,
        skipped: parsed.data.skipped ?? 0,
        durationMs: parsed.data.durationMs,
        reason: parsed.data.reason,
      },
    });
    return Response.json({ ok: true });
  },
);

export async function GET(): Promise<Response> {
  return errorResponse(
    405,
    "VALIDATION_ERROR",
    "Method Not Allowed — use POST",
  );
}
