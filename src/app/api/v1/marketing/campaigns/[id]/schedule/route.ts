import { and, eq } from "drizzle-orm";
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

    await db
      .update(marketingCampaigns)
      .set({
        status: "scheduled",
        scheduledFor,
        updatedAt: new Date(),
        updatedById: key.createdById,
      })
      .where(
        and(
          eq(marketingCampaigns.id, idParse.data.id),
          eq(marketingCampaigns.status, "draft"),
        ),
      );

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
