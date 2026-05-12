import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { canEditTemplate, canViewTemplate } from "@/lib/marketing/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — Single-template REST.
 *
 *   GET     read one
 *   PUT     update — mass-assignment guard limits the patch surface
 *           to name/description/subject/preheader/unlayerDesignJson/
 *           renderedHtml/status. Lock fence and audit live in the
 *           server-action equivalent; this REST surface is a
 *           lightweight admin tool for scripting.
 *   DELETE  soft-delete (sets isDeleted, deletedAt, archives)
 */

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  preheader: z.string().trim().max(255).nullable().optional(),
  unlayerDesignJson: z.record(z.unknown()).optional(),
  renderedHtml: z.string().optional(),
  status: z.enum(["draft", "ready", "archived"]).optional(),
  // Phase 29 §4 — Scope is read-only on this surface; promote/demote
  // goes through the in-app `changeTemplateScopeAction` so the OCC
  // gate + audit-event are uniform. API callers wanting to flip
  // visibility should re-create.
});

interface SerializedTemplate {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  preheader: string | null;
  status: "draft" | "ready" | "archived";
  scope: "global" | "personal";
  source: string;
  sendgrid_template_id: string | null;
  sendgrid_version_id: string | null;
  created_by_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

function serialize(t: typeof marketingTemplates.$inferSelect): SerializedTemplate {
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? null,
    subject: t.subject,
    preheader: t.preheader ?? null,
    status: t.status,
    scope: t.scope,
    source: t.source,
    sendgrid_template_id: t.sendgridTemplateId ?? null,
    sendgrid_version_id: t.sendgridVersionId ?? null,
    created_by_id: t.createdById,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    version: t.version,
  };
}

export const GET = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.templates.get" },
  async (_req, { key, params }) => {
    const [row] = await db
      .select()
      .from(marketingTemplates)
      .where(
        and(
          eq(marketingTemplates.id, params.id),
          eq(marketingTemplates.isDeleted, false),
        ),
      )
      .limit(1);
    if (!row) return errorResponse(404, "NOT_FOUND", "Template not found");

    // Phase 29 §4.4 — Visibility 404 for personal templates owned by
    // someone other than the API key's owner. We deliberately return
    // NOT_FOUND rather than FORBIDDEN to avoid leaking existence.
    if (
      !canViewTemplate({
        template: { scope: row.scope, createdById: row.createdById },
        userId: key.createdById,
      })
    ) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }
    return Response.json(serialize(row));
  },
);

export const PUT = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.templates.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = updateSchema.safeParse(body);
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
      .from(marketingTemplates)
      .where(
        and(
          eq(marketingTemplates.id, params.id),
          eq(marketingTemplates.isDeleted, false),
        ),
      )
      .limit(1);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }

    // Phase 29 §4.4/4.5 — visibility + edit gates. The API surface
    // has no `canMarketingTemplatesEdit` of its own; it inherits the
    // permission of the key's creator (the in-app user's
    // permissions are the source of truth). For now we treat API
    // keys as having the same edit rights their owner has — the
    // simplest mapping that preserves the principle of least
    // surprise.
    if (
      !canViewTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: key.createdById,
      })
    ) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }
    if (
      !canEditTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: key.createdById,
        // API keys carry no per-key edit permission; treat the
        // creator-id match as the only edit signal at this layer.
        // To "edit others" via API, the user must promote the
        // template to global through the in-app flow first.
        canMarketingTemplatesEdit: false,
      })
    ) {
      return errorResponse(
        403,
        "FORBIDDEN",
        existing.scope === "personal"
          ? "Only the creator's API key can edit a personal template."
          : "API keys cannot edit templates they didn't create. Use the in-app editor.",
      );
    }

    // Mass-assignment guard — only the documented fields can be
    // patched via this surface. updatedAt + version are stamped here.
    const patch: Partial<typeof marketingTemplates.$inferInsert> = {
      updatedById: key.createdById,
      updatedAt: new Date(),
      version: existing.version + 1,
    };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) {
      patch.description = parsed.data.description ?? null;
    }
    if (parsed.data.subject !== undefined) patch.subject = parsed.data.subject;
    if (parsed.data.preheader !== undefined) {
      patch.preheader = parsed.data.preheader ?? null;
    }
    if (parsed.data.unlayerDesignJson !== undefined) {
      patch.unlayerDesignJson = parsed.data.unlayerDesignJson;
    }
    if (parsed.data.renderedHtml !== undefined) {
      patch.renderedHtml = parsed.data.renderedHtml;
    }
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;

    const [updated] = await db
      .update(marketingTemplates)
      .set(patch)
      .where(eq(marketingTemplates.id, params.id))
      .returning();
    if (!updated) {
      return errorResponse(500, "INTERNAL_ERROR", "Failed to update template");
    }
    // Phase 22 — audit parity with the (app)/marketing/templates server
    // action. Diff captured as before/after of the patched fields only;
    // the full row is not snapshot to keep audit_log JSONB compact.
    await writeAudit({
      actorId: key.createdById,
      action: MARKETING_AUDIT_EVENTS.TEMPLATE_UPDATE,
      targetType: "marketing_template",
      targetId: params.id,
      before: {
        name: existing.name,
        subject: existing.subject,
        status: existing.status,
        version: existing.version,
      },
      after: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.subject !== undefined
          ? { subject: parsed.data.subject }
          : {}),
        ...(parsed.data.status !== undefined
          ? { status: parsed.data.status }
          : {}),
        version: updated.version,
        source: "api",
      },
    });
    return Response.json(serialize(updated));
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "admin", action: "marketing.templates.delete" },
  async (_req, { key, params }) => {
    const [existing] = await db
      .select({
        id: marketingTemplates.id,
        isDeleted: marketingTemplates.isDeleted,
        scope: marketingTemplates.scope,
        createdById: marketingTemplates.createdById,
      })
      .from(marketingTemplates)
      .where(eq(marketingTemplates.id, params.id))
      .limit(1);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }
    // Phase 29 §4 — same gates as PUT. Soft-delete is a write; only
    // the creator (or admin in-app) can issue it via API.
    if (
      !canViewTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: key.createdById,
      })
    ) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
    }
    if (
      !canEditTemplate({
        template: { scope: existing.scope, createdById: existing.createdById },
        userId: key.createdById,
        canMarketingTemplatesEdit: false,
      })
    ) {
      return errorResponse(
        403,
        "FORBIDDEN",
        existing.scope === "personal"
          ? "Only the creator's API key can delete a personal template."
          : "API keys cannot delete templates they didn't create. Use the in-app editor.",
      );
    }
    if (!existing.isDeleted) {
      await db
        .update(marketingTemplates)
        .set({
          status: "archived",
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: key.createdById,
          updatedById: key.createdById,
          updatedAt: new Date(),
        })
        .where(eq(marketingTemplates.id, params.id));
      // Phase 22 — audit parity with the (app)/marketing/templates
      // server action. The single-template GET selects only id +
      // isDeleted, so we don't carry a name into `before`.
      await writeAudit({
        actorId: key.createdById,
        action: MARKETING_AUDIT_EVENTS.TEMPLATE_DELETE,
        targetType: "marketing_template",
        targetId: params.id,
        before: { isDeleted: false },
        after: { isDeleted: true, source: "api" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
