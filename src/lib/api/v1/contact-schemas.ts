import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { paginatedListSchema } from "./schemas";

/**
 * Phase 13 — Contact schemas for /api/v1/contacts. Synthetic examples only.
 */

export const ContactSchema = registry.register(
  "Contact",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000020" }),
    account_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
    first_name: z.string().openapi({ example: "Jane" }),
    last_name: z.string().nullable().openapi({ example: "Doe" }),
    job_title: z.string().nullable().openapi({ example: "Director of HR" }),
    email: z
      .string()
      .nullable()
      .openapi({ example: "contact@example.com" }),
    phone: z.string().nullable().openapi({ example: "+1-555-0100" }),
    mobile_phone: z.string().nullable().openapi({ example: null }),
    description: z.string().nullable().openapi({ example: null }),
    do_not_contact: z.boolean().openapi({ example: false }),
    do_not_email: z.boolean().openapi({ example: false }),
    do_not_call: z.boolean().openapi({ example: false }),
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

export const ContactListResponseSchema = paginatedListSchema(
  ContactSchema,
  "ContactList",
);

export const ContactListQuerySchema = z.object({
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
    .openapi({ description: "Free-text search on name/email.", example: "jane" }),
  account_id: z
    .string()
    .uuid()
    .optional()
    .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
  owner_id: z.string().uuid().optional(),
});

export const ContactCreateSchema = registry.register(
  "ContactCreate",
  z.object({
    account_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .openapi({ example: "00000000-0000-0000-0000-000000000010" }),
    first_name: z.string().min(1).max(200).openapi({ example: "Jane" }),
    last_name: z.string().max(200).nullable().optional().openapi({ example: "Doe" }),
    job_title: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .openapi({ example: "Director of HR" }),
    email: z
      .string()
      .email()
      .max(254)
      .nullable()
      .optional()
      .openapi({ example: "contact@example.com" }),
    phone: z.string().max(60).nullable().optional().openapi({ example: "+1-555-0100" }),
    mobile_phone: z.string().max(60).nullable().optional(),
    description: z.string().max(20_000).nullable().optional(),
  }),
);

export const ContactUpdateSchema = registry.register(
  "ContactUpdate",
  ContactCreateSchema.partial().extend({
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

export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;
export type ContactCreateInput = z.infer<typeof ContactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateSchema>;
