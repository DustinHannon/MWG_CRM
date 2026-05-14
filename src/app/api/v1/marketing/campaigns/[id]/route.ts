import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { errorResponse } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { CampaignSchema } from "@/lib/api/v1/marketing-schemas";
import { StandardErrorResponses } from "@/lib/api/v1/schemas";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { registry } from "@/lib/openapi/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registry.registerPath({
  method: "get",
  path: "/marketing/campaigns/{id}",
  summary: "Read a campaign",
  description:
    "Returns the full campaign row including the current status, " +
    "scheduling fields, and webhook-fed counters (sent / delivered / " +
    "opened / clicked / bounced / unsubscribed). Poll this endpoint " +
    "after enqueuing a send via POST /send-now to observe state " +
    "progression (scheduled -> sending -> sent | failed).",
  tags: ["Marketing"],
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ description: "Campaign id" }),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: CampaignSchema } },
    },
    401: StandardErrorResponses[401],
    403: StandardErrorResponses[403],
    404: StandardErrorResponses[404],
    422: StandardErrorResponses[422],
    429: StandardErrorResponses[429],
  },
});

/**
 * Single campaign GET / PUT / DELETE.
 *
 * PUT mass-assignment guard: only the explicit allowlist below may be
 * patched. Anything else in the body is silently ignored.
 *
 * State gate: only `draft` campaigns may be updated or soft-deleted via
 * this surface. Use the dedicated /schedule, /cancel, /send-now routes
 * for state transitions.
 */

const IdParam = z.object({ id: z.string().uuid() });

const PutBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  templateId: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
  fromEmail: z.string().email().max(254).optional(),
  fromName: z.string().trim().min(1).max(120).optional(),
  replyToEmail: z.string().email().max(254).nullable().optional(),
  scheduledFor: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .transform((v) => (v ? new Date(v) : v)),
});

export const GET = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.get" },
  async (_req, { params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }
    const [row] = await db
      .select()
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.id, idParse.data.id),
          eq(marketingCampaigns.isDeleted, false),
        ),
      )
      .limit(1);
    if (!row) return errorResponse(404, "NOT_FOUND", "Campaign not found");
    return Response.json(row);
  },
);

export const PUT = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.update" },
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
    const parsed = PutBody.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const [existing] = await db
      .select()
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.id, idParse.data.id),
          eq(marketingCampaigns.isDeleted, false),
        ),
      )
      .limit(1);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Campaign not found");
    }
    if (existing.status !== "draft") {
      return errorResponse(
        409,
        "CONFLICT",
        "Only draft campaigns can be updated.",
      );
    }

    // Validate referenced FKs if changed.
    if (parsed.data.templateId) {
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
      if (!tpl) return errorResponse(404, "NOT_FOUND", "Template not found");
    }
    if (parsed.data.listId) {
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
      if (!list) return errorResponse(404, "NOT_FOUND", "List not found");
    }

    const patch: Record<string, unknown> = {
      updatedById: key.createdById,
      updatedAt: new Date(),
    };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.templateId !== undefined)
      patch.templateId = parsed.data.templateId;
    if (parsed.data.listId !== undefined) patch.listId = parsed.data.listId;
    if (parsed.data.fromEmail !== undefined)
      patch.fromEmail = parsed.data.fromEmail;
    if (parsed.data.fromName !== undefined)
      patch.fromName = parsed.data.fromName;
    if (parsed.data.replyToEmail !== undefined)
      patch.replyToEmail = parsed.data.replyToEmail ?? null;
    if (parsed.data.scheduledFor !== undefined)
      patch.scheduledFor = parsed.data.scheduledFor;

    await db
      .update(marketingCampaigns)
      .set(patch)
      .where(eq(marketingCampaigns.id, idParse.data.id));

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_UPDATE,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      after: { ...patch, source: "api" },
    });

    const [fresh] = await db
      .select()
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, idParse.data.id))
      .limit(1);
    return Response.json(fresh);
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.campaigns.delete" },
  async (_req, { key, params }) => {
    const idParse = IdParam.safeParse(params);
    if (!idParse.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid id");
    }

    const [existing] = await db
      .select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
        status: marketingCampaigns.status,
        isDeleted: marketingCampaigns.isDeleted,
      })
      .from(marketingCampaigns)
      .where(eq(marketingCampaigns.id, idParse.data.id))
      .limit(1);
    if (!existing || existing.isDeleted) {
      return errorResponse(404, "NOT_FOUND", "Campaign not found");
    }
    if (existing.status !== "draft" && existing.status !== "cancelled") {
      return errorResponse(
        409,
        "CONFLICT",
        "Only draft or cancelled campaigns can be deleted.",
      );
    }

    await db
      .update(marketingCampaigns)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: key.createdById,
        updatedAt: new Date(),
        updatedById: key.createdById,
      })
      .where(eq(marketingCampaigns.id, idParse.data.id));

    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.CAMPAIGN_DELETE,
      targetType: "marketing_campaign",
      targetId: idParse.data.id,
      before: { name: existing.name, status: existing.status },
    });

    return new Response(null, { status: 204 });
  },
);
