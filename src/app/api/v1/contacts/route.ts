import {
  createContact,
  getContactForApi,
  listContactsForApi,
} from "@/lib/contacts";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  ContactCreateSchema,
  ContactListQuerySchema,
  ContactListResponseSchema,
  ContactSchema,
} from "@/lib/api/v1/contact-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeContact } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTACT_DESCRIPTION =
  "API keys see all org-owned contacts regardless of which user generated " +
  "the key.";

registry.registerPath({
  method: "get",
  path: "/contacts",
  summary: "List contacts",
  description: "Returns a paginated list of contacts. " + CONTACT_DESCRIPTION,
  tags: ["Contacts"],
  security: [{ BearerAuth: [] }],
  request: { query: ContactListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ContactListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/contacts",
  summary: "Create contact",
  tags: ["Contacts"],
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ContactCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ContactSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "read:contacts", action: "contacts.list" },
  async (req, { key }) => {
    const url = new URL(req.url);
    const parsed = ContactListQuerySchema.safeParse(
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
    const result = await listContactsForApi({
      q: parsed.data.q,
      accountId: parsed.data.account_id,
      ownerId: parsed.data.owner_id,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ownerScope: { actorId: key.createdById, canViewAll: true },
    });
    return Response.json({
      data: result.rows.map((r) => serializeContact(r)),
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
  { scope: "write:contacts", action: "contacts.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = ContactCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const m = parsed.data;
    const created = await createContact(
      {
        accountId: m.account_id ?? null,
        firstName: m.first_name,
        lastName: m.last_name ?? null,
        jobTitle: m.job_title ?? null,
        email: m.email ?? null,
        phone: m.phone ?? null,
        mobilePhone: m.mobile_phone ?? null,
        description: m.description ?? null,
        street1: m.street1 ?? null,
        street2: m.street2 ?? null,
        city: m.city ?? null,
        state: m.state ?? null,
        postalCode: m.postal_code ?? null,
        country: m.country ?? null,
        birthdate: m.birthdate ?? null,
        doNotEmail: m.do_not_email ?? false,
        doNotCall: m.do_not_call ?? false,
        doNotMail: m.do_not_mail ?? false,
      },
      key.createdById,
    );
    const fresh = await getContactForApi(created.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(fresh ? serializeContact(fresh) : { id: created.id }, {
      status: 201,
    });
  },
);
