import {
  createOpportunity,
  getOpportunityForApi,
  listOpportunitiesForApi,
} from "@/lib/opportunities";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  OpportunityCreateSchema,
  OpportunityListQuerySchema,
  OpportunityListResponseSchema,
  OpportunitySchema,
} from "@/lib/api/v1/opportunity-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeOpportunity } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPP_DESCRIPTION =
  "API keys see all org-owned opportunities regardless of which user " +
  "generated the key.";

registry.registerPath({
  method: "get",
  path: "/opportunities",
  summary: "List opportunities",
  description: "Returns a paginated list of opportunities. " + OPP_DESCRIPTION,
  tags: ["Opportunities"],
  security: [{ BearerAuth: [] }],
  request: { query: OpportunityListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OpportunityListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/opportunities",
  summary: "Create opportunity",
  tags: ["Opportunities"],
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: OpportunityCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: OpportunitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "read:opportunities", action: "opportunities.list" },
  async (req, { key }) => {
    const url = new URL(req.url);
    const parsed = OpportunityListQuerySchema.safeParse(
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
    const result = await listOpportunitiesForApi({
      q: parsed.data.q,
      stage: parsed.data.stage,
      accountId: parsed.data.account_id,
      ownerId: parsed.data.owner_id,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ownerScope: { actorId: key.createdById, canViewAll: true },
    });
    return Response.json({
      data: result.rows.map((r) => serializeOpportunity(r)),
      meta: {
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / result.pageSize)),
      },
    });
  },
);

export const POST = withApi(
  { scope: "write:opportunities", action: "opportunities.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = OpportunityCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const m = parsed.data;
    const created = await createOpportunity(
      {
        accountId: m.account_id,
        primaryContactId: m.primary_contact_id ?? null,
        name: m.name,
        stage: m.stage ?? "prospecting",
        amount:
          m.amount === undefined || m.amount === null
            ? null
            : m.amount.toFixed(2),
        expectedCloseDate: m.expected_close_date ?? null,
        description: m.description ?? null,
      },
      key.createdById,
    );
    const fresh = await getOpportunityForApi(created.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(
      fresh ? serializeOpportunity(fresh) : { id: created.id },
      { status: 201 },
    );
  },
);
