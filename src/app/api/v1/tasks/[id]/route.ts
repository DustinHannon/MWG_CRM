import {
  archiveTasksById,
  deleteTasksById,
  getTaskForApi,
  updateTask,
} from "@/lib/tasks";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { TaskSchema, TaskUpdateSchema } from "@/lib/api/v1/task-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeTask } from "@/lib/api/v1/serializers";
import { writeAudit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ example: "00000000-0000-0000-0000-000000000040" }),
});

registry.registerPath({
  method: "get",
  path: "/tasks/{id}",
  summary: "Get task by id",
  tags: ["Tasks"],
  security: [{ BearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TaskSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/tasks/{id}",
  summary: "Update task",
  description:
    "Partial update. Optional `version` for optimistic concurrency.",
  tags: ["Tasks"],
  security: [{ BearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: TaskUpdateSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TaskSchema } } },
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
  path: "/tasks/{id}",
  summary: "Delete task",
  description:
    "Soft-delete by default. `?force=true` + `admin` scope hard-deletes.",
  tags: ["Tasks"],
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
  { scope: "read:tasks", action: "tasks.get" },
  async (_req, { key, params }) => {
    const row = await getTaskForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!row) return errorResponse(404, "NOT_FOUND", "Task not found");
    return Response.json(serializeTask(row));
  },
);

export const PATCH = withApi<{ id: string }>(
  { scope: "write:tasks", action: "tasks.update" },
  async (req, { key, params }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = TaskUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const existing = await getTaskForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Task not found");

    if (
      typeof parsed.data.version === "number" &&
      parsed.data.version !== existing.version
    ) {
      return errorResponse(
        409,
        "CONFLICT",
        "Task was modified by someone else; refresh and retry.",
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
    if (m.title !== undefined) patch.title = m.title;
    if (m.description !== undefined) patch.description = m.description ?? null;
    if (m.status !== undefined) patch.status = m.status;
    if (m.priority !== undefined) patch.priority = m.priority;
    if (m.due_at !== undefined) {
      patch.dueAt = m.due_at ? new Date(m.due_at) : null;
    }
    if (m.assigned_to_id !== undefined) {
      patch.assignedToId = m.assigned_to_id ?? null;
    }

    try {
      // The existing updateTask requires a version. Fall back to the
      // existing row's version when caller omitted one (last-write-wins).
      await updateTask(
        params.id,
        typeof parsed.data.version === "number"
          ? parsed.data.version
          : existing.version,
        patch,
        key.createdById,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        return errorResponse(409, "CONFLICT", "Task was modified.");
      }
      if (err instanceof NotFoundError) {
        return errorResponse(404, "NOT_FOUND", "Task not found");
      }
      throw err;
    }

    const fresh = await getTaskForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(fresh ? serializeTask(fresh) : { id: params.id });
  },
);

export const DELETE = withApi<{ id: string }>(
  { scope: "delete:tasks", action: "tasks.delete" },
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
    const existing = await getTaskForApi(params.id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    if (!existing) return errorResponse(404, "NOT_FOUND", "Task not found");
    if (force) {
      await deleteTasksById([params.id]);
      await writeAudit({
        actorId: key.createdById,
        action: "task.hard_delete",
        targetType: "tasks",
        targetId: params.id,
        before: { source: "api" },
      });
    } else {
      await archiveTasksById([params.id], key.createdById, "API delete");
      await writeAudit({
        actorId: key.createdById,
        action: "task.archive",
        targetType: "tasks",
        targetId: params.id,
        after: { source: "api", reason: "API delete" },
      });
    }
    return new Response(null, { status: 204 });
  },
);
