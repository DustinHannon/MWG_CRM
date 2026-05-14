import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { CampaignSendNowResponseSchema } from "@/lib/api/v1/marketing-schemas";
import { ErrorBodySchema, StandardErrorResponses } from "@/lib/api/v1/schemas";
import { writeAudit } from "@/lib/audit";
import { env, sendgridConfigured } from "@/lib/env";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { registry } from "@/lib/openapi/registry";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registry.registerPath({
  method: "post",
  path: "/marketing/campaigns/{id}/send-now",
  summary: "Enqueue a campaign for immediate dispatch",
  description:
    "Asynchronous send. The route commits a state transition " +
    "(status -> scheduled, scheduled_for -> now) and returns 202 " +
    "Accepted with a job descriptor. The marketing-process-scheduled-" +
    "campaigns cron picks up the row within one cadence (~60s) and " +
    "runs the SendGrid batch pipeline. Poll the returned statusUrl to " +
    "observe sending/sent/failed.\n\nOnly draft|scheduled campaigns " +
    "can be enqueued; sending/sent/failed/cancelled return 409.",
  tags: ["Marketing"],
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ description: "Campaign id" }),
    }),
  },
  responses: {
    202: {
      description: "Accepted — campaign enqueued for async dispatch",
      content: {
        "application/json": { schema: CampaignSendNowResponseSchema },
      },
    },
    401: StandardErrorResponses[401],
    403: StandardErrorResponses[403],
    404: StandardErrorResponses[404],
    409: {
      description:
        "Conflict — campaign is not in draft|scheduled state, or a " +
        "concurrent caller claimed it first.",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
    422: StandardErrorResponses[422],
    429: StandardErrorResponses[429],
    503: {
      description:
        "Service unavailable — SendGrid is not configured for this environment.",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
  },
});

/**
 * POST /api/v1/marketing/campaigns/{id}/send-now
 *
 * Enqueues a draft|scheduled campaign for immediate dispatch. The send
 * is asynchronous: the route returns 202 Accepted with a job descriptor
 * after committing the state transition (status -> scheduled,
 * scheduled_for -> now). The marketing-process-scheduled-campaigns cron
 * picks up the row within one cadence (~60s) and runs the SendGrid
 * batch pipeline; subsequent state (sending, sent, failed) is observable
 * via GET /api/v1/marketing/campaigns/{id}.
 *
 * Rate-limited per API key by env.RATE_LIMIT_CAMPAIGN_SEND_PER_USER_PER_HOUR.
 */

const IdParam = z.object({ id: z.string().uuid() });
const POLL_INTERVAL_SECONDS = 5;

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

    // Atomic enqueue — status guard in the WHERE clause closes the
    // TOCTOU race between the SELECT above and the UPDATE below. The
    // cron picker also runs an atomic claim transitioning scheduled ->
    // sending, so a duplicate POST hitting after the cron has already
    // claimed the row will find status=sending and 409 cleanly.
    const transition = await db
      .update(marketingCampaigns)
      .set({
        status: "scheduled",
        scheduledFor: sql`now()`,
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
      .returning({
        id: marketingCampaigns.id,
        scheduledFor: marketingCampaigns.scheduledFor,
      });
    if (transition.length === 0) {
      // SELECT showed the campaign was eligible; UPDATE found nothing
      // — eligibility was lost between the two (cron claimed first, or
      // a concurrent caller flipped the row).
      return errorResponse(
        409,
        "CONFLICT",
        "Campaign is already being sent or is no longer eligible.",
      );
    }

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_SEND_ENQUEUED,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      before: { status: existing.status },
      after: {
        status: "scheduled",
        scheduledFor: transition[0].scheduledFor,
        source: "api",
      },
    });

    return Response.json(
      {
        ok: true,
        jobId: idParse.data.id,
        campaignId: idParse.data.id,
        status: "scheduled",
        scheduledFor: transition[0].scheduledFor,
        statusUrl: `/api/v1/marketing/campaigns/${idParse.data.id}`,
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      },
      { status: 202 },
    );
  },
);
