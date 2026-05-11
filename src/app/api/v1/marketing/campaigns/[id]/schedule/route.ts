import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — POST /api/v1/marketing/campaigns/{id}/schedule
 *
 * Body: { scheduledFor: ISO8601 }
 *
 * State transition: draft → scheduled. The cron processor picks up
 * scheduled rows when scheduledFor is in the past.
 */

const Body = z.object({
  scheduledFor: z.string().datetime(),
  // Phase 25 §5.2 — optional OCC token. When provided, the UPDATE
  // refuses to schedule a campaign whose version has been bumped
  // since the caller read it. Existing API consumers without
  // version-awareness keep working; only race-aware clients pay
  // for the strictness.
  expectedVersion: z.number().int().nonnegative().optional(),
});

const IdParam = z.object({ id: z.string().uuid() });

export const POST = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.schedule" },
  async (req, { key, params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid scheduledFor");
    }
    const scheduledFor = new Date(parsed.data.scheduledFor);
    if (scheduledFor.getTime() <= Date.now()) {
      return errorResponse(
        422,
        "VALIDATION_ERROR",
        "Scheduled time must be in the future.",
      );
    }

    const [existing] = await db
      .select({
        id: marketingCampaigns.id,
        status: marketingCampaigns.status,
        scheduledFor: marketingCampaigns.scheduledFor,
        isDeleted: marketingCampaigns.isDeleted,
        version: marketingCampaigns.version,
      })
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, idParse.data.id))
      .limit(1);
    if (!existing || existing.isDeleted) {
      return errorResponse(404, "NOT_FOUND", "Campaign not found");
    }
    if (existing.status !== "draft") {
      return errorResponse(
        409,
        "CONFLICT",
        "Only draft campaigns can be scheduled.",
      );
    }

    // Phase 25 §5.2 — OCC enforcement matching the server-action path.
    const whereClauses = [
      eq(marketingCampaigns.id, idParse.data.id),
      eq(marketingCampaigns.status, "draft"),
    ];
    if (parsed.data.expectedVersion !== undefined) {
      whereClauses.push(
        eq(marketingCampaigns.version, parsed.data.expectedVersion),
      );
    }

    const updated = await db
      .update(marketingCampaigns)
      .set({
        status: "scheduled",
        scheduledFor,
        updatedAt: new Date(),
        updatedById: key.createdById,
        version: sql`${marketingCampaigns.version} + 1`,
      })
      .where(and(...whereClauses))
      .returning({ id: marketingCampaigns.id });

    if (updated.length === 0) {
      // Phase 25 §5.2 — version mismatch (or status flipped between
      // the SELECT above and this UPDATE). Surfaces as the canonical
      // CONFLICT api error code; the message hints at the recovery
      // path (refresh-and-retry).
      return errorResponse(
        409,
        "CONFLICT",
        "This campaign was modified by someone else. Refresh and try again.",
      );
    }

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SCHEDULE,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      before: {
        status: existing.status,
        scheduledFor: existing.scheduledFor,
      },
      after: {
        status: "scheduled",
        scheduledFor: scheduledFor.toISOString(),
        source: "api",
      },
    });

    return new Response(null, { status: 204 });
  },
);
