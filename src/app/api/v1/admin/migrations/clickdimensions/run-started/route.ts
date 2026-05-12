import { z } from "zod";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { sessionFromKey } from "@/lib/api/v1/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Records that an extraction run has started.
 *
 * The Playwright extraction script POSTs this once at startup so the
 * worklist UI can show "Last run started at X". Audit-event-only;
 * no table row is written — the per-template upserts in
 * /templates already cover state.
 */

const RunStartedPayload = z.object({
  runId: z.string().min(1).max(128),
  totalCandidateCount: z.number().int().min(0).optional(),
  limit: z.number().int().min(0).optional(),
  hostname: z.string().max(255).optional(),
});

export const POST = withApi(
  {
    scope: "marketing.migrations.api",
    action: "marketing.migration.run.started",
  },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = RunStartedPayload.safeParse(body);
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
      action: MARKETING_AUDIT_EVENTS.MIGRATION_RUN_STARTED,
      targetType: "clickdimensions_migration",
      targetId: parsed.data.runId,
      after: {
        runId: parsed.data.runId,
        totalCandidateCount: parsed.data.totalCandidateCount ?? null,
        limit: parsed.data.limit ?? null,
        hostname: parsed.data.hostname ?? null,
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
