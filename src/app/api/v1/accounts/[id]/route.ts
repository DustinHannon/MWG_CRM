import {
  archiveAccountsById,
  deleteAccountsById,
  getAccountForApi,
  updateAccountForApi,
} from "@/lib/accounts";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import {
  AccountSchema,
  AccountUpdateSchema,
} from "@/lib/api/v1/account-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeAccount } from "@/lib/api/v1/serializers";
import { ConflictError, NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
});

registry.registerPath({
  method: "get",
  path: "/accounts/{id}",
  summary: "Get account by id",
  tags: ["Accounts"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AccountSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/accounts/{id}",
  summary: "Update account",
  description:
    "Partial update. When `version` is supplied and does not match, returns 409.",
  tags: ["Accounts"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AccountUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: AccountSchema } } },
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
  path: "/accounts/{id}",
  summary: "Delete account",
  description:
    "Soft-deletes by default. Pass `?force=true` AND use a key with the " +
    "`admin` scope to hard-delete.",
  tags: ["Accounts"],
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
  { scope: "read:accounts", action: "accounts.get" },
  async (_req, { key, params }) => {
    const row = await getAccountForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!row) return errorResponse(404, "NOT_FOUND", "Account not found");
    return Response.json(serializeAccount(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:accounts", action: "accounts.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = AccountUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const existing = await getAccountForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Account not found");

    if (
      typeof parsed.data.version === "number" &&
      parsed.data.version !== existing.version
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Account was modified by someone else; refresh and retry.",
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
    if (m.name !== undefined) patch.name = m.name;
    if (m.industry !== undefined) patch.industry = m.industry ?? null;
    if (m.website !== undefined) patch.website = m.website ?? null;
    if (m.phone !== undefined) patch.phone = m.phone ?? null;
    if (m.street1 !== undefined) patch.street1 = m.street1 ?? null;
    if (m.street2 !== undefined) patch.street2 = m.street2 ?? null;
    if (m.city !== undefined) patch.city = m.city ?? null;
    if (m.state !== undefined) patch.state = m.state ?? null;
    if (m.postal_code !== undefined) patch.postalCode = m.postal_code ?? null;
    if (m.country !== undefined) patch.country = m.country ?? null;
    if (m.description !== undefined) patch.description = m.description ?? null;
    if (m.owner_id !== undefined) patch.ownerId = m.owner_id ?? null;
    try {
      await updateAccountForApi(
        params.id,
        patch,
        typeof parsed.data.version === "number" ? parsed.data.version : undefined,
        key.createdById,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(
          409,
          "CONFLICT",
          "Account was modified by someone else; refresh and retry.",
        );
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Account not found");
      }
      throw err;
    }
    const fresh = await getAccountForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(fresh ? serializeAccount(fresh) : { id: params.id });
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:accounts", action: "accounts.delete" },
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
    const existing = await getAccountForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Account not found");
    if (force) {
      await deleteAccountsById([params.id]);
    } else {
      await archiveAccountsById([params.id], key.createdById, "API delete");
    }
    return new Response(null, { status: 204 });
  },
);
