import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { ALL_SCOPES } from "@/lib/api/scopes";

/**
 * Phase 13 — Meta endpoint schemas (/me, /users).
 */

export const MeSchema = registry.register(
  "Me",
  z.object({
    api_key: z.object({
      id: z
        .string()
        .uuid()
        .openapi({ example: "00000000-0000-0000-0000-000000000099" }),
      name: z.string().openapi({ example: "Integrations bot" }),
      prefix: z.string().openapi({ example: "mwg_live_a1b" }),
      scopes: z
        .array(z.string())
        .openapi({ example: ["read:leads", "write:leads"] }),
      rate_limit_per_minute: z.number().int().openapi({ example: 60 }),
      expires_at: z
        .string()
        .datetime()
        .nullable()
        .openapi({ example: null }),
      last_used_at: z
        .string()
        .datetime()
        .nullable()
        .openapi({ example: "2026-05-08T19:00:00Z" }),
    }),
    creator: z.object({
      id: z
        .string()
        .uuid()
        .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
      email: z
        .string()
        .openapi({ example: "contact@example.com" }),
      display_name: z.string().openapi({ example: "Jane Doe" }),
      is_admin: z.boolean().openapi({ example: false }),
    }),
    available_scopes: z
      .array(z.string())
      .openapi({
        description: "Catalogue of every valid scope name.",
        example: [...ALL_SCOPES],
      }),
  }),
);

export const UserSummarySchema = registry.register(
  "UserSummary",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    email: z.string().openapi({ example: "contact@example.com" }),
    display_name: z.string().openapi({ example: "Jane Doe" }),
    first_name: z.string().openapi({ example: "Jane" }),
    last_name: z.string().nullable().openapi({ example: "Doe" }),
    is_admin: z.boolean().openapi({ example: false }),
    is_active: z.boolean().openapi({ example: true }),
    job_title: z.string().nullable().openapi({ example: "Account Executive" }),
    department: z.string().nullable(),
    created_at: z.string().datetime(),
  }),
);

export const UserListResponseSchema = registry.register(
  "UserList",
  z.object({
    data: z.array(UserSummarySchema),
    meta: z.object({
      page: z.number().int().openapi({ example: 1 }),
      page_size: z.number().int().openapi({ example: 50 }),
      total: z.number().int().openapi({ example: 25 }),
      total_pages: z.number().int().openapi({ example: 1 }),
    }),
  }),
);
