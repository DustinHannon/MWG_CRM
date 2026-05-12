import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Marketing campaigns (list + create draft).
 *
 * Read scope: `read:marketing` (falls through to admin).
 * Write scope: `write:marketing`.
 *
 * Mirrors the leads route shape but without registering OpenAPI paths
 * (the public /apihelp page intentionally hides marketing endpoints
 * pending a separate surface for them).
 */

const ListQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  status: z.string().optional(),
});

const CreateBody = z.object({
  templateId: z.string().uuid(),
  listId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().trim().min(1).max(120).optional(),
  replyToEmail: z.string().email().optional(),
});

export const GET = withApi(
  { scope: "admin", action: "marketing.campaigns.list" },
  async (req) => {
    const url = new URL(req.url);
    const parsed = ListQuery.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid query parameters", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const conditions = [eq(marketingCampaigns.isDeleted, false)];
    if (parsed.data.status) {
      // Validate against the enum values from the schema.
      conditions.push(
        eq(
          marketingCampaigns.status,
          parsed.data.status as
            | "draft"
            | "scheduled"
            | "sending"
            | "sent"
            | "failed"
            | "cancelled",
        ),
      );
    }

    const offset = (parsed.data.page - 1) * parsed.data.pageSize;

    const rows = await db
      .select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
        status: marketingCampaigns.status,
        templateId: marketingCampaigns.templateId,
        listId: marketingCampaigns.listId,
        scheduledFor: marketingCampaigns.scheduledFor,
        sentAt: marketingCampaigns.sentAt,
        totalRecipients: marketingCampaigns.totalRecipients,
        totalSent: marketingCampaigns.totalSent,
        totalDelivered: marketingCampaigns.totalDelivered,
        totalOpened: marketingCampaigns.totalOpened,
        totalClicked: marketingCampaigns.totalClicked,
        totalBounced: marketingCampaigns.totalBounced,
        totalUnsubscribed: marketingCampaigns.totalUnsubscribed,
        createdAt: marketingCampaigns.createdAt,
        updatedAt: marketingCampaigns.updatedAt,
      })
      .from(marketingCampaigns)
      .where(and(...conditions))
      .orderBy(desc(marketingCampaigns.updatedAt))
      .limit(parsed.data.pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(marketingCampaigns)
      .where(and(...conditions));

    return Response.json({
      data: rows,
      meta: {
        page: parsed.data.page,
        page_size: parsed.data.pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
      },
    });
  },
);

export const POST = withApi(
  { scope: "admin", action: "marketing.campaigns.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    // Validate referenced entities exist.
    const [tpl] = await db
      .select({ id: marketingTemplates.id })
      .from(marketingTemplates)
      .where(
        and(
          eq(marketingTemplates.id, parsed.data.templateId),
          eq(marketingTemplates.isDeleted, false),
        ),
      )
      .limit(1);
    if (!tpl) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }

    const [list] = await db
      .select({ id: marketingLists.id })
      .from(marketingLists)
      .where(
        and(
          eq(marketingLists.id, parsed.data.listId),
          eq(marketingLists.isDeleted, false),
        ),
      )
      .limit(1);
    if (!list) {
      return errorResponse(404, "NOT_FOUND", "List not found");
    }

    const name =
      parsed.data.name?.trim() ||
      `Campaign — ${new Date().toISOString().slice(0, 10)}`;

    const [created] = await db
      .insert(marketingCampaigns)
      .values({
        name,
        templateId: parsed.data.templateId,
        listId: parsed.data.listId,
        fromEmail:
          parsed.data.fromEmail ?? `noreply@${env.SENDGRID_FROM_DOMAIN}`,
        fromName: parsed.data.fromName ?? env.SENDGRID_FROM_NAME_DEFAULT,
        replyToEmail: parsed.data.replyToEmail ?? null,
        status: "draft",
        createdById: key.createdById,
        updatedById: key.createdById,
      })
      .returning();

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_CREATE,
      targetType: "marketing_campaign",
      targetId: created.id,
      after: { name, source: "api" },
    });

    return Response.json(created, { status: 201 });
  },
);
