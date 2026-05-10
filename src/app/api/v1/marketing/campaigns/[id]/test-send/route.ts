import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { writeAudit } from "@/lib/audit";
import { env, sendgridConfigured } from "@/lib/env";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { rateLimit } from "@/lib/security/rate-limit";
import { sendTestEmail } from "@/lib/marketing/sendgrid/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — POST /api/v1/marketing/campaigns/{id}/test-send
 *
 * Body: { recipientEmail }
 *
 * Issues a one-off SendGrid send using the campaign's template. Does
 * NOT change campaign status; it's purely a preview path. Rate-limited
 * per caller key.
 */

const IdParam = z.object({ id: z.string().uuid() });
const Body = z.object({
  recipientEmail: z.string().email().max(254),
});

export const POST = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.test_send" },
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
      return errorResponse(422, "VALIDATION_ERROR", "Invalid recipientEmail");
    }
    if (!sendgridConfigured) {
      return errorResponse(
        503,
        "INTERNAL_ERROR",
        "SendGrid is not configured for this environment.",
      );
    }

    const limit = await rateLimit(
      { kind: "test_send", principal: key.id },
      env.RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR,
      60 * 60,
    );
    if (!limit.allowed) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        "Test-send budget exceeded. Try again later.",
      );
    }

    const [campaign] = await db
      .select()
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.id, idParse.data.id),
          eq(marketingCampaigns.isDeleted, false),
        ),
      )
      .limit(1);
    if (!campaign) {
      return errorResponse(404, "NOT_FOUND", "Campaign not found");
    }

    const [tpl] = await db
      .select({
        subject: marketingTemplates.subject,
        html: marketingTemplates.renderedHtml,
      })
      .from(marketingTemplates)
      .where(
        and(
          eq(marketingTemplates.id, campaign.templateId),
          eq(marketingTemplates.isDeleted, false),
        ),
      )
      .limit(1);
    if (!tpl) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }

    const { messageId } = await sendTestEmail({
      recipientEmail: parsed.data.recipientEmail,
      subject: tpl.subject,
      html: tpl.html,
      fromName: campaign.fromName,
      actorUserId: key.createdById,
      featureRecordId: idParse.data.id,
    });

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_TEST_SEND,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      after: {
        recipientEmail: parsed.data.recipientEmail,
        messageId,
        source: "api",
      },
    });

    return Response.json({ messageId });
  },
);
