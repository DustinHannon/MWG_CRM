import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";

/**
 * shared OpenAPI schemas. Every entity defines its own
 * Lead/Account/Contact/etc. schema next to its route, but the common
 * envelope shapes (pagination meta, error body) live here so they're
 * registered once and referenced everywhere.
 */

export const ErrorBodySchema = registry.register(
  "ErrorBody",
  z.object({
    error: z.object({
      code: z.string().openapi({ example: "VALIDATION_ERROR" }),
      message: z
        .string()
        .openapi({ example: "Field 'status' must be one of [...]" }),
      details: z
        .array(
          z.object({
            field: z.string().optional(),
            issue: z.string(),
          }),
        )
        .optional(),
    }),
  }),
);

export const PaginationMetaSchema = registry.register(
  "PaginationMeta",
  z.object({
    page: z.number().int().openapi({ example: 1 }),
    page_size: z.number().int().openapi({ example: 50 }),
    total: z.number().int().openapi({ example: 1234 }),
    total_pages: z.number().int().openapi({ example: 25 }),
  }),
);

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({
    description: "1-indexed page number.",
    example: 1,
  }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({
      description: "Items per page (10–200).",
      example: 50,
    }),
});

export const StandardErrorResponses = {
  400: { description: "Bad request" },
  401: {
    description: "Unauthorized — missing, invalid, expired, or revoked token",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
  403: {
    description: "Forbidden — token lacks required scope",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
  404: {
    description: "Not found",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
  422: {
    description: "Validation error",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
  429: {
    description: "Rate limited",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
  500: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorBodySchema } },
  },
} as const;

/**
 * Helper that takes an array-of-records schema and wraps it in the
 * paginated envelope. Used by every list endpoint.
 */
export function paginatedListSchema<T extends z.ZodTypeAny>(
  itemSchema: T,
  refName: string,
) {
  return registry.register(
    refName,
    z.object({
      data: z.array(itemSchema),
      meta: PaginationMetaSchema,
    }),
  );
}
