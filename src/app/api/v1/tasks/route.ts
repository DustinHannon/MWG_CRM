import { sql } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema/tasks";
import { writeAudit } from "@/lib/audit";
import { getTaskForApi, listTasksForApi } from "@/lib/tasks";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import { registry } from "@/lib/openapi/registry";
import {
  TaskCreateSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskSchema,
} from "@/lib/api/v1/task-schemas";
import { ErrorBodySchema } from "@/lib/api/v1/schemas";
import { serializeTask } from "@/lib/api/v1/serializers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TASK_DESCRIPTION =
  "API keys see all org-owned tasks regardless of which user generated " +
  "the key.";

registry.registerPath({
  method: "get",
  path: "/tasks",
  summary: "List tasks",
  description: "Returns a paginated list of tasks. " + TASK_DESCRIPTION,
  tags: ["Tasks"],
  security: [{ BearerAuth: [] }],
  request: { query: TaskListQuerySchema },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: TaskListResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/tasks",
  summary: "Create task",
  tags: ["Tasks"],
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: TaskCreateSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TaskSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorBodySchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorBodySchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorBodySchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorBodySchema } } },
  },
});

export const GET = withApi(
  { scope: "read:tasks", action: "tasks.list" },
  async (req, { key }) => {
    const url = new URL(req.url);
    const parsed = TaskListQuerySchema.safeParse(
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
    const result = await listTasksForApi({
      status: parsed.data.status,
      assignedToId: parsed.data.assigned_to_id,
      leadId: parsed.data.lead_id,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      ownerScope: { actorId: key.createdById, canViewAll: true },
    });
    return Response.json({
      data: result.rows.map((r) => serializeTask(r as unknown as Record<string, unknown>)),
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
  { scope: "write:tasks", action: "tasks.create" },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }
    const parsed = TaskCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid request body", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }
    const m = parsed.data;
    // Insert directly to support all four optional parent FKs. The
    // existing `createTask` helper only handles leadId; tasks can also
    // attach to account/contact/opportunity via the v1 contract.
    const inserted = await db
      .insert(tasks)
      .values({
        title: m.title,
        description: m.description ?? null,
        priority: m.priority ?? "normal",
        dueAt: m.due_at ? new Date(m.due_at) : null,
        assignedToId: m.assigned_to_id ?? key.createdById,
        createdById: key.createdById,
        leadId: m.lead_id ?? null,
        accountId: m.account_id ?? null,
        contactId: m.contact_id ?? null,
        opportunityId: m.opportunity_id ?? null,
      })
      .returning({ id: tasks.id });
    void sql; // unused-import guard
    await writeAudit({
      actorId: key.createdById,
      action: "task.create",
      targetType: "tasks",
      targetId: inserted[0].id,
      after: { title: m.title, source: "api" },
    });
    const fresh = await getTaskForApi(inserted[0].id, {
      actorId: key.createdById,
      canViewAll: true,
    });
    return Response.json(
      fresh ? serializeTask(fresh) : { id: inserted[0].id },
      { status: 201 },
    );
  },
);
