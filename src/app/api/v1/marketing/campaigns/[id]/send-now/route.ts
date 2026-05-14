import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { writeAudit } from "@/lib/audit";
import { env, sendgridConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { rateLimit } from "@/lib/security/rate-limit";
import { sendCampaign } from "@/lib/marketing/sendgrid/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/marketing/campaigns/{id}/send-now
 *
 * State transition: draft|scheduled → sending. Kicks off the SendGrid
 * batch via Sub-agent A's `sendCampaign(id)` helper. Rate-limited
 * caller key by the env budget.
 */

const IdParam = z.object({ id: z.string().uuid() });

export const POST = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.send_now" },
  async (_req, { key, params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }
    if (!sendgridConfigured) {
      return errorResponse(
        503,
        "INTERNAL_ERROR",
        "SendGrid is not configured for this environment.",
      );
    }

    const limit = await rateLimit(
      { kind: "campaign_send", principal: key.id },
      env.RATE_LIMIT_CAMPAIGN_SEND_PER_USER_PER_HOUR,
      60 * 60,
    );
    if (!limit.allowed) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "Campaign send budget exceeded. Try again later.",
      );
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
        "Only draft or scheduled campaigns can be sent now.",
      );
    }

    // Atomic claim — status guard in the WHERE clause closes the
    // TOCTOU race between the SELECT above and the UPDATE below. A
    // duplicate POST (retry / replay) or a race against the cron
    // scheduled-pickup must NOT be able to force-flip a sent/failed/
    // sending/cancelled campaign back to 'sending' and trigger a
    // second batch dispatch. Mirrors the action-layer pattern in
    // sendCampaignNowAction (campaigns/actions.ts).
    const transition = await db
      .update(marketingCampaigns)
      .set({
        status: "sending",
        updatedAt: new Date(),
        updatedById: key.createdById,
      })
      .where(
        and(
          eq(marketingCampaigns.id, idParse.data.id),
          eq(marketingCampaigns.isDeleted, false),
          inArray(marketingCampaigns.status, ["draft", "scheduled"]),
        ),
      )
      .returning({ id: marketingCampaigns.id });
    if (transition.length === 0) {
      // SELECT showed the campaign was eligible; UPDATE found nothing
      // — eligibility was lost between the two (cron claimed first, or
      // a concurrent caller flipped the row). 409 distinguishes the
      // race from a true not-found.
      return errorResponse(
        409,
        "CONFLICT",
        "Campaign is already being sent or is no longer eligible.",
      );
    }

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_STARTED,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      before: { status: existing.status },
      after: { status: "sending", source: "api" },
    });

    try {
      await sendCampaign(idParse.data.id);
    } catch (err) {
      logger.error("campaign.send_failed", {
        campaignId: idParse.data.id,
        actorId: key.createdById,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Send pipeline rejected the request.",
      );
    }

    return new Response(null, { status: 202 });
  },
);
