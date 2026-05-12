import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { paginatedListSchema } from "./schemas";

/**
 * Account schemas for /api/v1/accounts.
 *
 * Synthetic examples only. Underlying SQL table is `crm_accounts`
 * (the Auth.js `accounts` table is a separate concern); the public
 * API surfaces them as "accounts".
 */

export const AccountSchema = registry.register(
  "Account",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
    name: z.string().openapi({ example: "Acme Corp" }),
    account_number: z.string().nullable().openapi({ example: "OLD-39857FFOV" }),
    industry: z.string().nullable().openapi({ example: "Insurance" }),
    website: z.string().nullable().openapi({ example: "https://acme.example" }),
    email: z.string().nullable().openapi({ example: "ar@acme.example" }),
    phone: z.string().nullable().openapi({ example: "+1-555-0100" }),
    number_of_employees: z.number().int().nullable().openapi({ example: 120 }),
    annual_revenue: z.string().nullable().openapi({ example: "5400000.00" }),
    street1: z.string().nullable().openapi({ example: "123 Main St" }),
    street2: z.string().nullable().openapi({ example: null }),
    city: z.string().nullable().openapi({ example: "Jackson" }),
    state: z.string().nullable().openapi({ example: "MS" }),
    postal_code: z.string().nullable().openapi({ example: "39201" }),
    country: z.string().nullable().openapi({ example: "USA" }),
    description: z.string().nullable().openapi({ example: null }),
    parent_account_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: null }),
    primary_contact_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: null }),
    owner_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    source_lead_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: null }),
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

export const AccountListResponseSchema = paginatedListSchema(
  AccountSchema,
  "AccountList",
);

export const AccountListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
  pageSize: z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .default(50)
    .openapi({ example: 50 }),
  q: z
    .string()
    .optional()
    .openapi({ description: "Free-text search on name.", example: "acme" }),
  owner_id: z
    .string()
    .uuid()
    .optional()
    .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
});

export const AccountCreateSchema = registry.register(
  "AccountCreate",
  z.object({
    name: z.string().min(1).max(200).openapi({ example: "Acme Corp" }),
    account_number: z.string().max(100).nullable().optional(),
    industry: z
      .string()
      .max(100)
      .nullable()
      .optional()
      .openapi({ example: "Insurance" }),
    website: z
      .string()
      .url()
      .nullable()
      .optional()
      .openapi({ example: "https://acme.example" }),
    email: z.string().email().max(254).nullable().optional(),
    phone: z
      .string()
      .max(60)
      .nullable()
      .optional()
      .openapi({ example: "+1-555-0100" }),
    number_of_employees: z.number().int().min(0).max(10_000_000).nullable().optional(),
    annual_revenue: z.number().min(0).nullable().optional(),
    street1: z.string().max(200).nullable().optional().openapi({ example: "123 Main St" }),
    street2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional().openapi({ example: "Jackson" }),
    state: z.string().max(100).nullable().optional().openapi({ example: "MS" }),
    postal_code: z.string().max(20).nullable().optional().openapi({ example: "39201" }),
    country: z.string().max(100).nullable().optional().openapi({ example: "USA" }),
    description: z.string().max(20_000).nullable().optional(),
    parent_account_id: z.string().uuid().nullable().optional(),
    primary_contact_id: z.string().uuid().nullable().optional(),
    owner_id: z.string().uuid().nullable().optional(),
  }),
);

export const AccountUpdateSchema = registry.register(
  "AccountUpdate",
  AccountCreateSchema.partial().extend({
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
        example: 1,
      }),
  }),
);

export type AccountListQuery = z.infer<typeof AccountListQuerySchema>;
export type AccountCreateInput = z.infer<typeof AccountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof AccountUpdateSchema>;
