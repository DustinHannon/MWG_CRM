import { z } from "zod";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { sessionFromKey } from "@/lib/api/v1/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 29 §7 — Records that the extraction script's D365 session
 * expired mid-run and the script halted gracefully. Operator must
 * re-auth (delete storage.json + re-run auth.ts) and resume.
 */

const SessionExpiredPayload = z.object({
  runId: z.string().min(1).max(128),
  processedBeforeExpiry: z.number().int().min(0).optional(),
  detectedAtUrl: z.string().max(2000).optional(),
});

export const POST = withApi(
  {
    scope: "marketing.migrations.api",
    action: "marketing.migration.session.expired",
  },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = SessionExpiredPayload.safeParse(body);
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
      action: MARKETING_AUDIT_EVENTS.MIGRATION_SESSION_EXPIRED,
      targetType: "clickdimensions_migration",
      targetId: parsed.data.runId,
      after: {
        runId: parsed.data.runId,
        processedBeforeExpiry:
          parsed.data.processedBeforeExpiry ?? null,
        detectedAtUrl: parsed.data.detectedAtUrl ?? null,
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
