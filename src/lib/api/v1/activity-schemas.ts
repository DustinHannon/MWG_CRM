import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { paginatedListSchema } from "./schemas";

/**
 * Phase 13 — Activity schemas for /api/v1/activities.
 *
 * Activities have a CHECK-constrained "exactly one parent" rule —
 * exactly one of {lead_id, account_id, contact_id, opportunity_id}
 * must be set on insert. The route enforces this and verifies the
 * parent isn't soft-deleted (returns 422 with parent_archived issue
 * detail when it is).
 */

export const ACTIVITY_KINDS = [
  "email",
  "call",
  "meeting",
  "note",
  "task",
] as const;

export const ACTIVITY_DIRECTIONS = ["inbound", "outbound", "internal"] as const;

export const ActivitySchema = registry.register(
  "Activity",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000050" }),
    lead_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000001" }),
    account_id: z.string().uuid().nullable(),
    contact_id: z.string().uuid().nullable(),
    opportunity_id: z.string().uuid().nullable(),
    user_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    kind: z.enum(ACTIVITY_KINDS).openapi({ example: "note" }),
    direction: z.enum(ACTIVITY_DIRECTIONS).nullable().openapi({ example: null }),
    subject: z.string().nullable().openapi({ example: null }),
    body: z
      .string()
      .nullable()
      .openapi({ example: "Initial intro call notes." }),
    occurred_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
    duration_minutes: z.number().int().nullable().openapi({ example: null }),
    outcome: z.string().nullable().openapi({ example: null }),
    created_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
    updated_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
  }),
);

export const ActivityListResponseSchema = paginatedListSchema(
  ActivitySchema,
  "ActivityList",
);

export const ActivityListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
  lead_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  opportunity_id: z.string().uuid().optional(),
  kind: z.enum(ACTIVITY_KINDS).optional(),
});

export const ActivityCreateSchema = registry.register(
  "ActivityCreate",
  z.object({
    lead_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .openapi({ example: "00000000-0000-0000-0000-000000000001" }),
    account_id: z.string().uuid().nullable().optional(),
    contact_id: z.string().uuid().nullable().optional(),
    opportunity_id: z.string().uuid().nullable().optional(),
    kind: z.enum(ACTIVITY_KINDS).openapi({ example: "note" }),
    direction: z
      .enum(ACTIVITY_DIRECTIONS)
      .nullable()
      .optional()
      .openapi({ example: null }),
    subject: z.string().max(240).nullable().optional(),
    body: z
      .string()
      .max(20_000)
      .nullable()
      .optional()
      .openapi({ example: "Initial intro call notes." }),
    occurred_at: z
      .string()
      .datetime()
      .optional()
      .openapi({
        description:
          "ISO-8601 timestamp. Defaults to current server time when omitted.",
        example: "2026-01-15T10:30:00Z",
      }),
    duration_minutes: z.number().int().min(0).max(1440).nullable().optional(),
    outcome: z.string().max(120).nullable().optional(),
  }),
);

export const ActivityUpdateSchema = registry.register(
  "ActivityUpdate",
  z.object({
    subject: z.string().max(240).nullable().optional(),
    body: z.string().max(20_000).nullable().optional(),
    outcome: z.string().max(120).nullable().optional(),
    duration_minutes: z.number().int().min(0).max(1440).nullable().optional(),
    direction: z.enum(ACTIVITY_DIRECTIONS).nullable().optional(),
    occurred_at: z.string().datetime().optional(),
  }),
);

export type ActivityListQuery = z.infer<typeof ActivityListQuerySchema>;
export type ActivityCreateInput = z.infer<typeof ActivityCreateSchema>;
export type ActivityUpdateInput = z.infer<typeof ActivityUpdateSchema>;
