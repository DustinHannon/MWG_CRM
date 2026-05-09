import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/leads";
import { paginatedListSchema } from "./schemas";

/**
 * Phase 13 — Lead schemas for /api/v1/leads.
 *
 * These DOUBLE as Zod runtime validators (used by the route handler)
 * AND OpenAPI schemas (rendered on /apihelp). The `.openapi()` calls
 * attach examples and descriptions; they don't change runtime
 * behavior.
 *
 * IMPORTANT: every example value is synthetic. No real customer
 * names, emails, or UUIDs.
 */

export const LeadSchema = registry.register(
  "Lead",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000001" }),
    first_name: z.string().openapi({ example: "Jane" }),
    last_name: z.string().nullable().openapi({ example: "Doe" }),
    company_name: z.string().nullable().openapi({ example: "Acme Corp" }),
    email: z
      .string()
      .nullable()
      .openapi({ example: "contact@example.com" }),
    phone: z.string().nullable().openapi({ example: "+1-555-0100" }),
    status: z.enum(LEAD_STATUSES).openapi({ example: "qualified" }),
    rating: z.enum(LEAD_RATINGS).openapi({ example: "warm" }),
    source: z.enum(LEAD_SOURCES).openapi({ example: "web" }),
    owner_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    estimated_value: z
      .string()
      .nullable()
      .openapi({ example: "12500.00" }),
    last_activity_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
    updated_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
    created_at: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-10T09:00:00Z" }),
    tags: z
      .array(z.string())
      .nullable()
      .openapi({ example: ["enterprise", "renewal"] }),
  }),
);

export const LeadListResponseSchema = paginatedListSchema(
  LeadSchema,
  "LeadList",
);

export const LeadListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
  status: z
    .string()
    .optional()
    .openapi({
      description:
        "Comma-separated list of statuses (intake/multi-value not supported in v1 — pass first match).",
      example: "qualified",
    }),
  q: z
    .string()
    .optional()
    .openapi({ description: "Free-text search.", example: "acme" }),
  owner_id: z
    .string()
    .uuid()
    .optional()
    .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
});

export const LeadCreateSchema = registry.register(
  "LeadCreate",
  z.object({
    first_name: z.string().min(1).openapi({ example: "Jane" }),
    last_name: z.string().nullable().optional().openapi({ example: "Doe" }),
    company_name: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "Acme Corp" }),
    email: z
      .string()
      .email()
      .nullable()
      .optional()
      .openapi({ example: "contact@example.com" }),
    phone: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "+1-555-0100" }),
    status: z.enum(LEAD_STATUSES).optional().openapi({ example: "new" }),
    rating: z.enum(LEAD_RATINGS).optional().openapi({ example: "warm" }),
    source: z.enum(LEAD_SOURCES).optional().openapi({ example: "web" }),
    owner_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    estimated_value: z
      .number()
      .nonnegative()
      .nullable()
      .optional()
      .openapi({ example: 12500 }),
  }),
);

export const LeadUpdateSchema = registry.register(
  "LeadUpdate",
  LeadCreateSchema.partial().extend({
    version: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({
        description:
          "Optional optimistic-concurrency token. If supplied and " +
          "mismatched, the request returns 409 CONFLICT and the caller " +
          "should refetch.",
        example: 3,
      }),
  }),
);

export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;
export type LeadCreateInput = z.infer<typeof LeadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof LeadUpdateSchema>;
