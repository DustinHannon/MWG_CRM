import {
  archiveOpportunitiesById,
  deleteOpportunitiesById,
  getOpportunityForApi,
  updateOpportunityForApi,
} from "@/lib/opportunities";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import {
  OpportunitySchema,
  OpportunityUpdateSchema,
} from "@/lib/api/v1/opportunity-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeOpportunity } from "@/lib/api/v1/serializers";
import { writeAudit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000030" }),
});

registry.registerPath({
  method: "get",
  path: "/opportunities/{id}",
  summary: "Get opportunity by id",
  tags: ["Opportunities"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OpportunitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/opportunities/{id}",
  summary: "Update opportunity",
  description:
    "Partial update. `version` is required: GET the opportunity, send " +
    "back its `version`. On mismatch the request returns 409 " +
    "CONFLICT; a missing `version` is 422.",
  tags: ["Opportunities"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: OpportunityUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OpportunitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/opportunities/{id}",
  summary: "Delete opportunity",
  description:
    "Soft-delete by default. `?force=true` + `admin` scope hard-deletes.",
  tags: ["Opportunities"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi<{ id: string }>(
  { scope: "read:opportunities", action: "opportunities.get" },
  async (_req, { key, params }) => {
    const row = await getOpportunityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!row) return errorResponse(404, "NOT_FOUND", "Opportunity not found");
    return Response.json(serializeOpportunity(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:opportunities", action: "opportunities.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = OpportunityUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const existing = await getOpportunityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Opportunity not found");

    // OCC: `version` is schema-required (a missing/non-numeric value
    // already returned 422 above), so this guard is unconditional —
    // there is no last-write-wins path. Mismatch → 409 CONFLICT.
    if (parsed.data.version !== existing.version) {
      return errorResponse(
        409,
        "CONFLICT",
        "Opportunity was modified by someone else; refresh and retry.",
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
    const m = parsed.data;
    const patch: Record<string, unknown> = {};
    if (m.account_id !== undefined) patch.accountId = m.account_id;
    if (m.primary_contact_id !== undefined)
      patch.primaryContactId = m.primary_contact_id ?? null;
    if (m.name !== undefined) patch.name = m.name;
    if (m.stage !== undefined) patch.stage = m.stage;
    if (m.amount !== undefined) {
      patch.amount = m.amount === null ? null : m.amount.toFixed(2);
    }
    if (m.expected_close_date !== undefined) {
      patch.expectedCloseDate = m.expected_close_date ?? null;
    }
    if (m.description !== undefined) patch.description = m.description ?? null;
    try {
      // `version` is schema-required (missing -> 422 above), so it
      // is always a number here. Pass it through directly; the prior
      // `: undefined` branch produced an unconditional UPDATE
      // (pure last-write-wins) and is now removed.
      await updateOpportunityForApi(
        params.id,
        patch,
        parsed.data.version,
        key.createdById,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(409, "CONFLICT", "Opportunity was modified.");
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Opportunity not found");
      }
      throw err;
    }
    // `updateOpportunityForApi` lib helper does NOT emit
    // audit (the (app)/opportunities server action does). Mirror the
    // action's audit emit so API-key driven updates land in audit_log.
    await writeAudit({
      actorId: key.createdById,
      action: "opportunity.update",
      targetType: "opportunities",
      targetId: params.id,
      after: { ...patch, source: "api" },
    });
    const fresh = await getOpportunityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(
      fresh ? serializeOpportunity(fresh) : { id: params.id },
    );
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:opportunities", action: "opportunities.delete" },
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
    const existing = await getOpportunityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Opportunity not found");
    if (force) {
      await deleteOpportunitiesById([params.id]);
      await writeAudit({
        actorId: key.createdById,
        action: "opportunity.hard_delete",
        targetType: "opportunities",
        targetId: params.id,
        before: { source: "api" },
      });
    } else {
      await archiveOpportunitiesById([params.id], key.createdById, "API delete");
      await writeAudit({
        actorId: key.createdById,
        action: "opportunity.archive",
        targetType: "opportunities",
        targetId: params.id,
        after: { source: "api", reason: "API delete" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
