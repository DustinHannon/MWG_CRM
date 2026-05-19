import {
  getActivityForApi,
  softDeleteActivity,
  updateActivity,
} from "@/lib/activities";
import { ConflictError, NotFoundError } from "@/lib/errors";
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
    "outcome, duration_minutes, direction, occurred_at). Optimistic " +
    "concurrency: pass the `version` from the last GET to be rejected " +
    "with 409 if another writer changed the activity first; omit it to " +
    "update against the current version.",
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
    409: { description: "Version conflict", content: { "application/json": { schema: ErrorBodySchema } } },
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
    const patch: {
      subject?: string | null;
      body?: string | null;
      outcome?: string | null;
      durationMinutes?: number | null;
      direction?: "inbound" | "outbound" | "internal" | null;
      occurredAt?: Date;
    } = {};
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
    // OCC: `version` is optional on this endpoint (it was last-write-
    // wins before activities gained the column; requiring it would
    // break existing integrators). When omitted we fall back to the
    // just-read version, so the shared `updateActivity` path is still
    // atomic; when supplied, a concurrent edit yields 409.
    const expectedVersion = m.version ?? existing.version;
    let result: Awaited<ReturnType<typeof updateActivity>>;
    try {
      result = await updateActivity({
        id: params.id,
        patch,
        expectedVersion,
        actorId: key.createdById,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(
          409,
          "CONFLICT",
          "Activity was modified by someone else; refresh and retry.",
          {
            details: [
              {
                field: "version",
                issue: `Expected ${expectedVersion}, it has since changed`,
              },
            ],
          },
        );
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Activity not found");
      }
      throw err;
    }
    // The shared `updateActivity` lib helper does NOT emit audit (it is
    // also called by the (app) action, which audits). Mirror the (app)
    // action here so API-key driven updates land in audit_log with the
    // same `activity.update` taxonomy — now with before AND after.
    await writeAudit({
      actorId: key.createdById,
      action: "activity.update",
      // Canonical activity-audit targetType is singular "activity"
      // (every app action + /api/v1/activities POST use it). Plural
      // here was an inconsistency; no consumer keys off target_type
      // for this taxonomy (events.ts groups by the action prefix
      // "activity.", audit list filter is free-text exact-match).
      targetType: "activity",
      targetId: params.id,
      before: result.before,
      after: { ...result.after, source: "api" },
    });
    return Response.json(serializeActivity(result.after));
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
        // Canonical singular "activity" (see PATCH note above).
        targetType: "activity",
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
        // Canonical singular "activity" (see PATCH note above).
        targetType: "activity",
        targetId: params.id,
        after: { source: "api" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
