import { registry, openapiZ as z } from "@/lib/openapi/registry";

const CampaignStatusEnum = z
  .enum(["draft", "scheduled", "sending", "sent", "failed", "cancelled"])
  .openapi({
    description:
      "Campaign lifecycle state. Transitions: draft -> scheduled -> sending -> sent. " +
      "`failed` is a terminal state on send error; `cancelled` is admin-set before send.",
    example: "scheduled",
  });

/**
 * Subset of the marketing_campaigns row returned by
 * GET /api/v1/marketing/campaigns/{id}. Fields admins poll for state
 * + progress while a send is in flight.
 */
export const CampaignSchema = registry.register(
  "MarketingCampaign",
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    status: CampaignStatusEnum,
    templateId: z.string().uuid(),
    listId: z.string().uuid(),
    fromEmail: z.string().email(),
    fromName: z.string(),
    replyToEmail: z.string().email().nullable(),
    scheduledFor: z.string().datetime().nullable().openapi({
      description:
        "ISO timestamp when the campaign is scheduled to dispatch. " +
        "Set to `now()` by POST /send-now; the cron picker dispatches " +
        "when this value is in the past.",
    }),
    sentAt: z.string().datetime().nullable(),
    totalRecipients: z.number().int(),
    totalSent: z.number().int(),
    totalDelivered: z.number().int(),
    totalOpened: z.number().int(),
    totalClicked: z.number().int(),
    totalBounced: z.number().int(),
    totalUnsubscribed: z.number().int(),
    failureReason: z.string().nullable(),
    version: z.number().int(),
    createdById: z.string().uuid(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
);

/**
 * Async job descriptor returned by POST
 * /api/v1/marketing/campaigns/{id}/send-now. The route does not run
 * the SendGrid batch synchronously; it commits a state transition
 * (status -> scheduled, scheduled_for -> now) and returns immediately.
 * Callers poll `statusUrl` to observe sending/sent/failed.
 */
export const CampaignSendNowResponseSchema = registry.register(
  "MarketingCampaignSendNowResponse",
  z.object({
    ok: z.literal(true),
    jobId: z.string().uuid().openapi({
      description:
        "Identifier for polling the send. Equals `campaignId` — the " +
        "campaign IS the job; GET /api/v1/marketing/campaigns/{jobId} " +
        "returns current state.",
    }),
    campaignId: z.string().uuid(),
    status: z.literal("scheduled").openapi({
      description:
        "State immediately after enqueue. Transitions to `sending` " +
        "when the marketing-process-scheduled-campaigns cron claims " +
        "the row (within one cadence, ~60s), then to `sent` or " +
        "`failed` after the SendGrid batch completes.",
    }),
    scheduledFor: z.string().datetime().openapi({
      description:
        "ISO timestamp set to the enqueue moment. The cron picker " +
        "treats any campaign with scheduledFor <= now() and " +
        "status='scheduled' as eligible for dispatch.",
    }),
    statusUrl: z.string().openapi({
      description:
        "Relative path to poll for state progression. Issue a GET " +
        "request with the same Bearer token used for the send-now call.",
      example: "/api/v1/marketing/campaigns/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    pollIntervalSeconds: z.number().int().positive().openapi({
      description:
        "Suggested polling cadence in seconds. Bear in mind the cron " +
        "runs once per minute; polling more aggressively will not " +
        "advance the state faster.",
      example: 5,
    }),
  }),
);
