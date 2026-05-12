import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/marketing/campaigns/{id}/recipients
 *
 * Paginated recipient roster. Optional `?status=` filters by recipient
 * row status. Default page size 50.
 */

const IdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  status: z.string().optional(),
});

const RECIPIENT_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "dropped",
  "deferred",
  "blocked",
  "spamreport",
  "unsubscribed",
] as const;
type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const GET = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.recipients" },
  async (req, { params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }
    const url = new URL(req.url);
    const queryParse = ListQuery.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!queryParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid query");
    }

    const [campaign] = await db
      .select({ id: marketingCampaigns.id })
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

    let statusFilter: RecipientStatus | undefined;
    if (queryParse.data.status) {
      const candidate = queryParse.data.status as RecipientStatus;
      if (!RECIPIENT_STATUSES.includes(candidate)) {
        return errorResponse(
          422,
          "VALIDATION_ERROR",
          "Invalid status filter",
        );
      }
      statusFilter = candidate;
    }

    const conditions = [eq(campaignRecipients.campaignId, idParse.data.id)];
    if (statusFilter) {
      conditions.push(eq(campaignRecipients.status, statusFilter));
    }

    const offset = (queryParse.data.page - 1) * queryParse.data.pageSize;
    const rows = await db
      .select({
        id: campaignRecipients.id,
        email: campaignRecipients.email,
        leadId: campaignRecipients.leadId,
        status: campaignRecipients.status,
        firstOpenedAt: campaignRecipients.firstOpenedAt,
        firstClickedAt: campaignRecipients.firstClickedAt,
        openCount: campaignRecipients.openCount,
        clickCount: campaignRecipients.clickCount,
        bounceReason: campaignRecipients.bounceReason,
        deliveredAt: campaignRecipients.deliveredAt,
        sentAt: campaignRecipients.sentAt,
      })
      .from(campaignRecipients)
      .where(and(...conditions))
      .limit(queryParse.data.pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(and(...conditions));

    return Response.json({
      data: rows,
      meta: {
        page: queryParse.data.page,
        page_size: queryParse.data.pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / queryParse.data.pageSize)),
      },
    });
  },
);
