import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — Marketing template REST. Surface gated by the existing
 * `admin` super-scope (the scope catalogue has no per-entity
 * `read:marketing` slot). Listing and reading are safe enough for
 * any admin-key holder; mutation goes through the in-app server
 * actions.
 *
 * The shape mirrors `/api/v1/leads` — paginated `data` + `meta` block
 * — so existing API clients can reuse their list helpers.
 */

const listQuerySchema = z.object({
  status: z.enum(["draft", "ready", "archived"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  subject: z.string().trim().min(1).max(998),
  preheader: z.string().trim().max(255).optional(),
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

export const GET = withApi(
  { scope: "admin", action: "marketing.templates.list" },
  async (req) => {
    const url = new URL(req.url);
    const parsed = listQuerySchema.safeParse(
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
    const { status, page, pageSize } = parsed.data;

    const where = status
      ? and(
          eq(marketingTemplates.isDeleted, false),
          eq(marketingTemplates.status, status),
        )
      : eq(marketingTemplates.isDeleted, false);

    const offset = (page - 1) * pageSize;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(marketingTemplates)
        .where(where)
        .orderBy(desc(marketingTemplates.updatedAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(marketingTemplates)
        .where(where),
    ]);

    return Response.json({
      data: rows.map(serialize),
      meta: {
        page,
        page_size: pageSize,
        total: Number(total),
        total_pages: Math.max(1, Math.ceil(Number(total) / pageSize)),
      },
    });
  },
);

export const POST = withApi(
  { scope: "admin", action: "marketing.templates.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const [row] = await db
      .insert(marketingTemplates)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        subject: parsed.data.subject,
        preheader: parsed.data.preheader ?? null,
        unlayerDesignJson: {},
        renderedHtml: "",
        status: "draft",
        // API keys carry a creator id; mirror the lead-create pattern
        // and use the key's owner as the audited actor.
        createdById: key.createdById,
        updatedById: key.createdById,
      })
      .returning();
    if (!row) {
      return errorResponse(500, "INTERNAL_ERROR", "Failed to create template");
    }
    return Response.json(serialize(row), { status: 201 });
  },
);
