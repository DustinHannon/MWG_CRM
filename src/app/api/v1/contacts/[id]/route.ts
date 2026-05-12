import {
  archiveContactsById,
  deleteContactsById,
  getContactForApi,
  updateContactForApi,
} from "@/lib/contacts";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import {
  ContactSchema,
  ContactUpdateSchema,
} from "@/lib/api/v1/contact-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeContact } from "@/lib/api/v1/serializers";
import { writeAudit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000020" }),
});

registry.registerPath({
  method: "get",
  path: "/contacts/{id}",
  summary: "Get contact by id",
  tags: ["Contacts"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ContactSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/contacts/{id}",
  summary: "Update contact",
  description:
    "Partial update. Optional `version` for optimistic concurrency.",
  tags: ["Contacts"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ContactUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ContactSchema } } },
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
  path: "/contacts/{id}",
  summary: "Delete contact",
  description:
    "Soft-delete by default. `?force=true` + `admin` scope hard-deletes.",
  tags: ["Contacts"],
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
  { scope: "read:contacts", action: "contacts.get" },
  async (_req, { key, params }) => {
    const row = await getContactForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!row) return errorResponse(404, "NOT_FOUND", "Contact not found");
    return Response.json(serializeContact(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:contacts", action: "contacts.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = ContactUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const existing = await getContactForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Contact not found");

    if (
      typeof parsed.data.version === "number" &&
      parsed.data.version !== existing.version
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Contact was modified by someone else; refresh and retry.",
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
    if (m.account_id !== undefined) patch.accountId = m.account_id ?? null;
    if (m.first_name !== undefined) patch.firstName = m.first_name;
    if (m.last_name !== undefined) patch.lastName = m.last_name ?? null;
    if (m.job_title !== undefined) patch.jobTitle = m.job_title ?? null;
    if (m.email !== undefined) patch.email = m.email ?? null;
    if (m.phone !== undefined) patch.phone = m.phone ?? null;
    if (m.mobile_phone !== undefined) patch.mobilePhone = m.mobile_phone ?? null;
    if (m.description !== undefined) patch.description = m.description ?? null;
    try {
      await updateContactForApi(
        params.id,
        patch,
        typeof parsed.data.version === "number" ? parsed.data.version : undefined,
        key.createdById,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(409, "CONFLICT", "Contact was modified.");
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Contact not found");
      }
      throw err;
    }
    // `updateContactForApi` lib helper does NOT emit audit
    // (the (app)/contacts server action does). Mirror that here so
    // API-key driven updates land in audit_log too.
    await writeAudit({
      actorId: key.createdById,
      action: "contact.update",
      targetType: "contacts",
      targetId: params.id,
      after: { ...patch, source: "api" },
    });
    const fresh = await getContactForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(fresh ? serializeContact(fresh) : { id: params.id });
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:contacts", action: "contacts.delete" },
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
    const existing = await getContactForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Contact not found");
    if (force) {
      await deleteContactsById([params.id]);
      await writeAudit({
        actorId: key.createdById,
        action: "contact.hard_delete",
        targetType: "contacts",
        targetId: params.id,
        before: { source: "api" },
      });
    } else {
      await archiveContactsById([params.id], key.createdById, "API delete");
      await writeAudit({
        actorId: key.createdById,
        action: "contact.archive",
        targetType: "contacts",
        targetId: params.id,
        after: { source: "api", reason: "API delete" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
