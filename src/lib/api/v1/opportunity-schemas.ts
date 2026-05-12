import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import { paginatedListSchema } from "./schemas";

/**
 * Opportunity schemas for /api/v1/opportunities.
 * Synthetic examples only.
 */

export const OpportunitySchema = registry.register(
  "Opportunity",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000030" }),
    account_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
    primary_contact_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: null }),
    name: z.string().openapi({ example: "Acme — 2026 group health" }),
    stage: z.enum(OPPORTUNITY_STAGES).openapi({ example: "qualification" }),
    amount: z
      .string()
      .nullable()
      .openapi({ example: "75000.00" }),
    probability: z.number().int().nullable().openapi({ example: 40 }),
    expected_close_date: z
      .string()
      .nullable()
      .openapi({ example: "2026-06-30" }),
    description: z.string().nullable(),
    closed_at: z.string().datetime().nullable().openapi({ example: null }),
    owner_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
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

export const OpportunityListResponseSchema = paginatedListSchema(
  OpportunitySchema,
  "OpportunityList",
);

export const OpportunityListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
  q: z.string().optional().openapi({ description: "Free-text on name." }),
  stage: z.enum(OPPORTUNITY_STAGES).optional(),
  account_id: z.string().uuid().optional(),
  owner_id: z.string().uuid().optional(),
});

export const OpportunityCreateSchema = registry.register(
  "OpportunityCreate",
  z.object({
    account_id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
    primary_contact_id: z.string().uuid().nullable().optional(),
    name: z
      .string()
      .min(1)
      .max(200)
      .openapi({ example: "Acme — 2026 group health" }),
    stage: z
      .enum(OPPORTUNITY_STAGES)
      .optional()
      .openapi({ example: "prospecting" }),
    amount: z
      .number()
      .nonnegative()
      .nullable()
      .optional()
      .openapi({ example: 75000 }),
    expected_close_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional()
      .openapi({ example: "2026-06-30" }),
    description: z.string().max(20_000).nullable().optional(),
  }),
);

export const OpportunityUpdateSchema = registry.register(
  "OpportunityUpdate",
  OpportunityCreateSchema.partial().extend({
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

export type OpportunityListQuery = z.infer<typeof OpportunityListQuerySchema>;
export type OpportunityCreateInput = z.infer<typeof OpportunityCreateSchema>;
export type OpportunityUpdateInput = z.infer<typeof OpportunityUpdateSchema>;
