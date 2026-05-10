import { eq } from "drizzle-orm";
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
 * Phase 21 — POST /api/v1/marketing/campaigns/{id}/cancel
 *
 * State transition: draft|scheduled → cancelled.
 */

const IdParam = z.object({ id: z.string().uuid() });

export const POST = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.cancel" },
  async (_req, { key, params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }

    const [existing] = await db
      .select({
        id: marketingCampaigns.id,
        status: marketingCampaigns.status,
        isDeleted: marketingCampaigns.isDeleted,
      })
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, idParse.data.id))
      .limit(1);
    if (!existing || existing.isDeleted) {
      return errorResponse(404, "NOT_FOUND", "Campaign not found");
    }
    if (existing.status !== "draft" && existing.status !== "scheduled") {
      return errorResponse(
        409,
        "CONFLICT",
        "Only draft or scheduled campaigns can be cancelled.",
      );
    }

    await db
      .update(marketingCampaigns)
      .set({
        status: "cancelled",
        updatedAt: new Date(),
        updatedById: key.createdById,
      })
      .where(eq(marketingCampaigns.id, idParse.data.id));

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CANCEL,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      before: { status: existing.status },
      after: { status: "cancelled", source: "api" },
    });

    return new Response(null, { status: 204 });
  },
);
