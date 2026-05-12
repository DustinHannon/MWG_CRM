import {
  archiveLeadsById,
  deleteLeadsById,
  getLeadById,
  updateLead,
} from "@/lib/leads";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import { openapiZ as z } from "@/lib/openapi/registry";
import {
  LeadSchema,
  LeadUpdateSchema,
} from "@/lib/api/v1/lead-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { sessionFromKey } from "@/lib/api/v1/session";
import { serializeLead } from "@/lib/api/v1/serializers";
import { writeAudit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z.string().uuid().openapi({
    example: "00000000-0000-0000-0000-000000000001",
  }),
});

const ForceQuery = z.object({
  force: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When true, hard-deletes the row (irreversible). Requires the " +
        "`admin` scope. Default is soft-delete (archive).",
      example: "true",
    }),
});

registry.registerPath({
  method: "get",
  path: "/leads/{id}",
  summary: "Get lead by id",
  tags: ["Leads"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LeadSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/leads/{id}",
  summary: "Update lead",
  description:
    "Partial update. When `version` is supplied and does not match the " +
    "current row, returns 409 CONFLICT. Without `version`, last-write-wins.",
  tags: ["Leads"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: LeadUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LeadSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    409: { description: "Conflict (version mismatch)", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/leads/{id}",
  summary: "Delete lead",
  description:
    "Soft-deletes (archives) by default. Pass `?force=true` AND use a " +
    "key with the `admin` scope to hard-delete.",
  tags: ["Leads"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam, query: ForceQuery },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi<{ id: string }>(
  { scope: "read:leads", action: "leads.get" },
  async (_req, { key, params }) => {
    const user = await sessionFromKey(key);
    const row = await getLeadById(user, params.id, true);
    if (!row) {
      return errorResponse(404, "NOT_FOUND", "Lead not found");
    }
    return Response.json(serializeLead(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:leads", action: "leads.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = LeadUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const user = await sessionFromKey(key);
    const existing = await getLeadById(user, params.id, true);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Lead not found");
    }

    // OCC: when `version` provided and mismatched, return 409 CONFLICT.
    const expectedVersion =
      typeof parsed.data.version === "number"
        ? parsed.data.version
        : existing.version;
    if (
      typeof parsed.data.version === "number" &&
      parsed.data.version !== existing.version
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Lead was modified by someone else; refresh and retry.",
        {
          details: [
            {
              field: "version",
              issue: `Expected ${parsed.data.version}, current is ${existing.version}`,
            },
          ],
        },
      );
    }

    // Map snake_case → camelCase patch.
    const patch: Record<string, unknown> = {};
    const m = parsed.data;
    if (m.first_name !== undefined) patch.firstName = m.first_name;
    if (m.last_name !== undefined) patch.lastName = m.last_name ?? null;
    if (m.company_name !== undefined) patch.companyName = m.company_name ?? null;
    if (m.email !== undefined) patch.email = m.email ?? null;
    if (m.phone !== undefined) patch.phone = m.phone ?? null;
    if (m.job_title !== undefined) patch.jobTitle = m.job_title ?? null;
    if (m.industry !== undefined) patch.industry = m.industry ?? null;
    if (m.website !== undefined) patch.website = m.website ?? null;
    if (m.linkedin_url !== undefined) patch.linkedinUrl = m.linkedin_url ?? null;
    if (m.street1 !== undefined) patch.street1 = m.street1 ?? null;
    if (m.street2 !== undefined) patch.street2 = m.street2 ?? null;
    if (m.city !== undefined) patch.city = m.city ?? null;
    if (m.state !== undefined) patch.state = m.state ?? null;
    if (m.postal_code !== undefined) patch.postalCode = m.postal_code ?? null;
    if (m.country !== undefined) patch.country = m.country ?? null;
    if (m.description !== undefined) patch.description = m.description ?? null;
    if (m.subject !== undefined) patch.subject = m.subject ?? null;
    if (m.status !== undefined) patch.status = m.status;
    if (m.rating !== undefined) patch.rating = m.rating;
    if (m.source !== undefined) patch.source = m.source;
    if (m.do_not_contact !== undefined) patch.doNotContact = m.do_not_contact;
    if (m.do_not_email !== undefined) patch.doNotEmail = m.do_not_email;
    if (m.do_not_call !== undefined) patch.doNotCall = m.do_not_call;
    if (m.owner_id !== undefined) patch.ownerId = m.owner_id ?? null;
    if (m.estimated_value !== undefined) {
      patch.estimatedValue =
        m.estimated_value === null ? null : m.estimated_value.toFixed(2);
    }
    if (m.estimated_close_date !== undefined) {
      patch.estimatedCloseDate = m.estimated_close_date ?? null;
    }

    try {
      await updateLead(user, params.id, expectedVersion, patch);
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(
          409,
          "CONFLICT",
          "Lead was modified by someone else; refresh and retry.",
        );
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Lead not found");
      }
      throw err;
    }

    // `updateLead` lib helper does NOT emit audit (the
    // server action does). Match the (app)/leads server-action pattern
    // so API-key driven mutations land in audit_log too.
    await writeAudit({
      actorId: key.createdById,
      action: "lead.update",
      targetType: "lead",
      targetId: params.id,
      after: { ...patch, source: "api" },
    });

    const fresh = await getLeadById(user, params.id, true);
    return Response.json(fresh ? serializeLead(fresh) : { id: params.id });
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:leads", action: "leads.delete" },
  async (req, { key, params }) => {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    if (force && !key.scopes.includes("admin")) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "force=true requires the admin scope",
      );
    }
    const user = await sessionFromKey(key);
    const existing = await getLeadById(user, params.id, true);
    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Lead not found");
    }
    if (force) {
      await deleteLeadsById([params.id]);
      await writeAudit({
        actorId: key.createdById,
        action: "lead.hard_delete",
        targetType: "lead",
        targetId: params.id,
        before: { source: "api" },
      });
    } else {
      await archiveLeadsById([params.id], key.createdById, "API delete");
      await writeAudit({
        actorId: key.createdById,
        action: "lead.archive",
        targetType: "lead",
        targetId: params.id,
        after: { source: "api", reason: "API delete" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
