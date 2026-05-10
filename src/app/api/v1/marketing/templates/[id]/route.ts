import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";

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
});

interface SerializedTemplate {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  preheader: string | null;
  status: "draft" | "ready" | "archived";
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
  async (_req, { params }) => {
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
      })
      .from(marketingTemplates)
      .where(eq(marketingTemplates.id, params.id))
      .limit(1);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Template not found");
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
    }
    return new Response(null, { status: 204 });
  },
);
