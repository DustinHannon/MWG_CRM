import { listLeads } from "@/lib/leads";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  LeadListQuerySchema,
  LeadListResponseSchema,
} from "@/lib/api/v1/lead-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { sessionFromKey } from "@/lib/api/v1/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registry.registerPath({
  method: "get",
  path: "/leads",
  summary: "List leads",
  description:
    "Returns a paginated list of leads. API keys see all org-owned " +
    "leads regardless of which user generated the key.",
  tags: ["Leads"],
  security: [{ BearerAuth: [] }],
  request: { query: LeadListQuerySchema },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: LeadListResponseSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
    429: {
      description: "Rate limited",
      content: { "application/json": { schema: ErrorBodySchema } },
    },
  },
});

export const GET = withApi({ scope: "read:leads", action: "leads.list" }, async (req, { key }) => {
  const url = new URL(req.url);
  const parsed = LeadListQuerySchema.safeParse(
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

  const user = await sessionFromKey(key);
  const result = await listLeads(
    user,
    {
      q: parsed.data.q,
      status: parsed.data.status,
      ownerId: parsed.data.owner_id,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    },
    /* canViewAll */ true,
  );

  return Response.json({
    data: result.rows.map(serializeLead),
    meta: {
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      total_pages: Math.max(1, Math.ceil(result.total / result.pageSize)),
    },
  });
});

function serializeLead(row: {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  rating: string;
  source: string;
  ownerId: string | null;
  estimatedValue: string | null;
  lastActivityAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
  tags: string[] | null;
}) {
  return {
    id: row.id,
    first_name: row.firstName,
    last_name: row.lastName,
    company_name: row.companyName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    rating: row.rating,
    source: row.source,
    owner_id: row.ownerId,
    estimated_value: row.estimatedValue,
    last_activity_at: row.lastActivityAt
      ? row.lastActivityAt.toISOString()
      : null,
    updated_at: row.updatedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    tags: row.tags,
  };
}
