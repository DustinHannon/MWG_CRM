import {
  createAccount,
  getAccountForApi,
  listAccountsForApi,
} from "@/lib/accounts";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  AccountCreateSchema,
  AccountListQuerySchema,
  AccountListResponseSchema,
  AccountSchema,
} from "@/lib/api/v1/account-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { sessionFromKey } from "@/lib/api/v1/session";
import { serializeAccount } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACCOUNT_DESCRIPTION =
  "API keys see all org-owned accounts regardless of which user generated " +
  "the key.";

registry.registerPath({
  method: "get",
  path: "/accounts",
  summary: "List accounts",
  description: "Returns a paginated list of accounts. " + ACCOUNT_DESCRIPTION,
  tags: ["Accounts"],
  security: [{ BearerAuth: [] }],
  request: { query: AccountListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AccountListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/accounts",
  summary: "Create account",
  tags: ["Accounts"],
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AccountCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: AccountSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "read:accounts", action: "accounts.list" },
  async (req, { key }) => {
    const url = new URL(req.url);
    const parsed = AccountListQuerySchema.safeParse(
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
    const result = await listAccountsForApi({
      q: parsed.data.q,
      ownerId: parsed.data.owner_id,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ownerScope: { actorId: key.createdById, canViewAll: true },
    });
    return Response.json({
      data: result.rows.map((r) => serializeAccount(r)),
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
  { scope: "write:accounts", action: "accounts.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = AccountCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const m = parsed.data;
    const created = await createAccount(
      {
        name: m.name,
        industry: m.industry ?? null,
        website: m.website ?? null,
        phone: m.phone ?? null,
        street1: m.street1 ?? null,
        street2: m.street2 ?? null,
        city: m.city ?? null,
        state: m.state ?? null,
        postalCode: m.postal_code ?? null,
        country: m.country ?? null,
        description: m.description ?? null,
      },
      m.owner_id ?? key.createdById,
    );
    const fresh = await getAccountForApi(created.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(fresh ? serializeAccount(fresh) : { id: created.id }, {
      status: 201,
    });
  },
);
