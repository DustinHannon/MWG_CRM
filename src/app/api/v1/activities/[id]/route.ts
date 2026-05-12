import {
  getActivityForApi,
  softDeleteActivity,
  updateActivityForApi,
} from "@/lib/activities";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { eq } from "drizzle-orm";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import {
  ActivitySchema,
  ActivityUpdateSchema,
} from "@/lib/api/v1/activity-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeActivity } from "@/lib/api/v1/serializers";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000050" }),
});

registry.registerPath({
  method: "get",
  path: "/activities/{id}",
  summary: "Get activity by id",
  tags: ["Activities"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ActivitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/activities/{id}",
  summary: "Update activity",
  description:
    "Partial update on a small set of mutable fields (subject, body, " +
    "outcome, duration_minutes, direction, occurred_at). Activities " +
    "do not currently carry a `version` column; updates are last-write-wins.",
  tags: ["Activities"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: ActivityUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ActivitySchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/activities/{id}",
  summary: "Delete activity",
  description:
    "Soft-delete by default. `?force=true` + `admin` scope hard-deletes.",
  tags: ["Activities"],
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
  { scope: "read:activities", action: "activities.get" },
  async (_req, { key, params }) => {
    const row = await getActivityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!row) return errorResponse(404, "NOT_FOUND", "Activity not found");
    return Response.json(serializeActivity(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:activities", action: "activities.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = ActivityUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const existing = await getActivityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Activity not found");
    const m = parsed.data;
    const patch: Record<string, unknown> = {};
    if (m.subject !== undefined) patch.subject = m.subject ?? null;
    if (m.body !== undefined) patch.body = m.body ?? null;
    if (m.outcome !== undefined) patch.outcome = m.outcome ?? null;
    if (m.duration_minutes !== undefined) {
      patch.durationMinutes = m.duration_minutes ?? null;
    }
    if (m.direction !== undefined) patch.direction = m.direction ?? null;
    if (m.occurred_at !== undefined) {
      patch.occurredAt = new Date(m.occurred_at);
    }
    await updateActivityForApi(params.id, patch);
    // `updateActivityForApi` lib helper does NOT emit audit.
    // Mirror the (app) action's behaviour so API-key driven updates land
    // in audit_log with the same `activity.update` event taxonomy.
    await writeAudit({
      actorId: key.createdById,
      action: "activity.update",
      targetType: "activities",
      targetId: params.id,
      after: { ...patch, source: "api" },
    });
    const fresh = await getActivityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(
      fresh ? serializeActivity(fresh) : { id: params.id },
    );
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:activities", action: "activities.delete" },
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
    const existing = await getActivityForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Activity not found");
    if (force) {
      await db.delete(activities).where(eq(activities.id, params.id));
      await writeAudit({
        actorId: key.createdById,
        action: "activity.hard_delete",
        targetType: "activities",
        targetId: params.id,
        before: { source: "api" },
      });
    } else {
      // Bypass softDeleteActivity's per-actor authorship check — API
      // keys with `delete:activities` scope can archive any activity
      // in the org. This matches the broader API-key design (key acts
      // org-wide, not as the issuing user).
      await softDeleteActivity(params.id, key.createdById, /* isAdmin */ true);
      await writeAudit({
        actorId: key.createdById,
        action: "activity.archive",
        targetType: "activities",
        targetId: params.id,
        after: { source: "api" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
