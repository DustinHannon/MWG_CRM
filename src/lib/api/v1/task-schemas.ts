import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { paginatedListSchema } from "./schemas";

/**
 * Task schemas for /api/v1/tasks. Synthetic examples only.
 */

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const TaskSchema = registry.register(
  "Task",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000040" }),
    title: z.string().openapi({ example: "Follow up with Acme Corp" }),
    description: z.string().nullable().openapi({ example: null }),
    status: z.enum(TASK_STATUSES).openapi({ example: "open" }),
    priority: z.enum(TASK_PRIORITIES).openapi({ example: "normal" }),
    due_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: "2026-02-01T17:00:00Z" }),
    completed_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: null }),
    assigned_to_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    created_by_id: z.string().uuid().nullable(),
    lead_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000001" }),
    account_id: z.string().uuid().nullable(),
    contact_id: z.string().uuid().nullable(),
    opportunity_id: z.string().uuid().nullable(),
    version: z.number().int().openapi({ example: 1 }),
    created_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-10T09:00:00Z" }),
    updated_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
  }),
);

export const TaskListResponseSchema = paginatedListSchema(
  TaskSchema,
  "TaskList",
);

export const TaskListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
  status: z.enum(TASK_STATUSES).optional(),
  assigned_to_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
});

export const TaskCreateSchema = registry.register(
  "TaskCreate",
  z.object({
    title: z
      .string()
      .min(1)
      .max(200)
      .openapi({ example: "Follow up with Acme Corp" }),
    description: z.string().max(2000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional().openapi({ example: "normal" }),
    due_at: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: "2026-02-01T17:00:00Z" }),
    assigned_to_id: z.string().uuid().nullable().optional(),
    lead_id: z.string().uuid().nullable().optional(),
    account_id: z.string().uuid().nullable().optional(),
    contact_id: z.string().uuid().nullable().optional(),
    opportunity_id: z.string().uuid().nullable().optional(),
  }),
);

export const TaskUpdateSchema = registry.register(
  "TaskUpdate",
  z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    due_at: z.string().datetime().nullable().optional(),
    assigned_to_id: z.string().uuid().nullable().optional(),
    version: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({
        description:
          "Optional optimistic-concurrency token. If supplied and " +
          "mismatched, the request returns 409 CONFLICT.",
        example: 1,
      }),
  }),
);

export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;
export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
