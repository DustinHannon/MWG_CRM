import { createLead, getLeadById, listLeads } from "@/lib/leads";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  LeadCreateSchema,
  LeadListQuerySchema,
  LeadListResponseSchema,
  LeadSchema,
} from "@/lib/api/v1/lead-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { sessionFromKey } from "@/lib/api/v1/session";
import { serializeLead } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LEAD_DESCRIPTION =
  "API keys see all org-owned leads regardless of which user generated " +
  "the key.";

registry.registerPath({
  method: "get",
  path: "/leads",
  summary: "List leads",
  description: "Returns a paginated list of leads. " + LEAD_DESCRIPTION,
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

registry.registerPath({
  method: "post",
  path: "/leads",
  summary: "Create lead",
  description: "Creates a new lead and returns the persisted record.",
  tags: ["Leads"],
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: LeadCreateSchema } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: LeadSchema } },
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

export const GET = withApi(
  { scope: "read:leads", action: "leads.list" },
  async (req, { key }) => {
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
      data: result.rows.map((r) => serializeLead(r)),
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
  { scope: "write:leads", action: "leads.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = LeadCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const user = await sessionFromKey(key);
    const created = await createLead(user, {
      // The lib createLead path takes the camelCase shape; map the
      // snake_case API contract over.
      firstName: parsed.data.first_name,
      lastName: parsed.data.last_name ?? null,
      companyName: parsed.data.company_name ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      jobTitle: parsed.data.job_title ?? null,
      industry: parsed.data.industry ?? null,
      website: parsed.data.website ?? null,
      linkedinUrl: parsed.data.linkedin_url ?? null,
      street1: parsed.data.street1 ?? null,
      street2: parsed.data.street2 ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      postalCode: parsed.data.postal_code ?? null,
      country: parsed.data.country ?? null,
      description: parsed.data.description ?? null,
      subject: parsed.data.subject ?? null,
      status: parsed.data.status ?? "new",
      rating: parsed.data.rating ?? "warm",
      source: parsed.data.source ?? "other",
      doNotContact: parsed.data.do_not_contact ?? false,
      doNotEmail: parsed.data.do_not_email ?? false,
      doNotCall: parsed.data.do_not_call ?? false,
      ownerId: parsed.data.owner_id ?? null,
      estimatedValue:
        parsed.data.estimated_value === undefined ||
        parsed.data.estimated_value === null
          ? null
          : parsed.data.estimated_value.toFixed(2),
      estimatedCloseDate: parsed.data.estimated_close_date ?? null,
      salutation: parsed.data.salutation ?? null,
      mobilePhone: parsed.data.mobile_phone ?? null,
    });

    const fresh = await getLeadById(user, created.id, true);
    return Response.json(fresh ? serializeLead(fresh) : { id: created.id }, {
      status: 201,
    });
  },
);
