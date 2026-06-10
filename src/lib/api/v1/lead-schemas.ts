import "server-only";
import { openapiZ as z, registry } from "@/lib/openapi/registry";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/leads";
import { paginatedListSchema } from "./schemas";

/**
 * Lead schemas for /api/v1/leads.
 *
 * These DOUBLE as Zod runtime validators (used by the route handler)
 * AND OpenAPI schemas (rendered on /apihelp). The `.openapi()` calls
 * attach examples and descriptions; they don't change runtime
 * behavior.
 *
 * IMPORTANT: every example value is synthetic. No real customer
 * names, emails, or UUIDs.
 */

/**
 * URL accepting only http/https. `z.string().url()` alone accepts
 * `javascript:`, `data:`, and `vbscript:` URIs, which are then stored
 * and rendered as a clickable href — a stored-XSS sink. This mirrors
 * `urlField` in `@/lib/validation/primitives` so the public API enforces
 * the same protocol allow-list the UI/lib path already does.
 */
const httpUrlField = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "URL must use http or https",
  });

/**
 * Do-not-contact invariant: when `do_not_contact` is true,
 * `do_not_email` and `do_not_call` must not be false. Mirrors
 * `dncRefinement` in `@/lib/leads` (camelCase there) so the public API
 * enforces the identical server-side guarantee — the lib `createLead`/
 * `updateLead` paths do not re-validate, so this schema is the only gate
 * for API-origin writes.
 */
const dncRefinement = (data: {
  do_not_contact?: boolean | null;
  do_not_email?: boolean | null;
  do_not_call?: boolean | null;
}) => {
  if (!data.do_not_contact) return true;
  return data.do_not_email !== false && data.do_not_call !== false;
};

const DNC_REFINEMENT_MESSAGE =
  "Do Not Contact implies Do Not Email and Do Not Call — both must be true.";

export const LeadSchema = registry.register(
  "Lead",
  z.object({
    id: z
      .string()
      .uuid()
      .openapi({ example: "00000000-0000-0000-0000-000000000001" }),
    salutation: z.string().nullable().openapi({ example: "Mr." }),
    first_name: z.string().openapi({ example: "Jane" }),
    last_name: z.string().nullable().openapi({ example: "Doe" }),
    company_name: z.string().nullable().openapi({ example: "Acme Corp" }),
    email: z
      .string()
      .nullable()
      .openapi({ example: "contact@example.com" }),
    phone: z.string().nullable().openapi({ example: "+1-555-0100" }),
    mobile_phone: z.string().nullable().openapi({ example: "+1-555-0101" }),
    job_title: z.string().nullable().openapi({ example: "Director of HR" }),
    industry: z.string().nullable().openapi({ example: "Insurance" }),
    website: z.string().nullable().openapi({ example: "https://acme.example" }),
    linkedin_url: z.string().nullable(),
    street1: z.string().nullable(),
    street2: z.string().nullable(),
    city: z.string().nullable().openapi({ example: "Jackson" }),
    state: z.string().nullable().openapi({ example: "MS" }),
    postal_code: z.string().nullable().openapi({ example: "39201" }),
    country: z.string().nullable().openapi({ example: "USA" }),
    description: z.string().nullable(),
    subject: z.string().nullable(),
    status: z.enum(LEAD_STATUSES).openapi({ example: "qualified" }),
    rating: z.enum(LEAD_RATINGS).openapi({ example: "warm" }),
    source: z.enum(LEAD_SOURCES).openapi({ example: "web" }),
    do_not_contact: z.boolean().openapi({ example: false }),
    do_not_email: z.boolean().openapi({ example: false }),
    do_not_call: z.boolean().openapi({ example: false }),
    owner_id: z
      .string()
      .uuid()
      .nullable()
      .openapi({ example: "00000000-0000-0000-0000-000000000111" }),
    estimated_value: z
      .string()
      .nullable()
      .openapi({ example: "12500.00" }),
    estimated_close_date: z.string().nullable().openapi({ example: "2026-06-30" }),
    last_activity_at: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: "2026-01-15T10:30:00Z" }),
    converted_at: z.string().datetime().nullable().openapi({ example: null }),
    version: z.number().int().openapi({ example: 1 }),
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
    external_id: z
      .string()
      .nullable()
      .openapi({
        description: "Stable identifier from the source-of-record (e.g. D365 record GUID). Read-only; supplied at import time.",
        example: "MWG-LEAD-0001",
      }),
    score: z
      .number()
      .int()
      .openapi({
        description: "Lead-scoring engine output (0-100). Read-only.",
        example: 73,
      }),
    score_band: z
      .string()
      .openapi({
        description: "Bucketed score label (e.g. cold/warm/hot). Read-only.",
        example: "warm",
      }),
    created_via: z
      .string()
      .openapi({
        description: "Provenance: manual, imported, api, d365_sync, etc. Read-only.",
        example: "manual",
      }),
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

// Unrefined object base. `.refine()` produces a ZodEffects that has no
// `.partial()`, so LeadUpdateSchema is built from this base and the DNC
// refinement is re-applied to each registered schema separately (same
// pattern as `leadCreateSchemaBase` in @/lib/leads).
const leadCreateObject = z.object({
    salutation: z.string().max(20).nullable().optional().openapi({ example: "Mr." }),
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
    mobile_phone: z
      .string()
      .max(40)
      .nullable()
      .optional()
      .openapi({ example: "+1-555-0101" }),
    job_title: z.string().max(200).nullable().optional(),
    industry: z.string().max(100).nullable().optional(),
    website: httpUrlField.nullable().optional(),
    linkedin_url: httpUrlField.nullable().optional(),
    street1: z.string().max(200).nullable().optional(),
    street2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(100).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    country: z.string().max(100).nullable().optional(),
    description: z.string().max(20_000).nullable().optional(),
    subject: z.string().max(1000).nullable().optional(),
    status: z.enum(LEAD_STATUSES).optional().openapi({ example: "new" }),
    rating: z.enum(LEAD_RATINGS).optional().openapi({ example: "warm" }),
    source: z.enum(LEAD_SOURCES).optional().openapi({ example: "web" }),
    do_not_contact: z.boolean().optional(),
    do_not_email: z.boolean().optional(),
    do_not_call: z.boolean().optional(),
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
    estimated_close_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional()
      .openapi({ example: "2026-06-30" }),
  });

export const LeadCreateSchema = registry.register(
  "LeadCreate",
  leadCreateObject.refine(dncRefinement, {
    message: DNC_REFINEMENT_MESSAGE,
    path: ["do_not_contact"],
  }),
);

export const LeadUpdateSchema = registry.register(
  "LeadUpdate",
  leadCreateObject
    .partial()
    .extend({
      version: z
        .number({
          required_error: "version is required for updates",
          invalid_type_error: "version must be a number",
        })
        .int()
        .nonnegative()
        .openapi({
          description:
            "Required optimistic-concurrency token. GET the resource " +
            "first, then send back its current version value. If it " +
            "no longer matches the stored row the request returns 409 " +
            "CONFLICT; refetch and retry.",
          example: 3,
        }),
    })
    .refine(dncRefinement, {
      message: DNC_REFINEMENT_MESSAGE,
      path: ["do_not_contact"],
    }),
);

export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;
export type LeadCreateInput = z.infer<typeof LeadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof LeadUpdateSchema>;
