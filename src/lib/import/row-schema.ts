// Phase 6E — Zod schema for a parsed import row, post-normalisation.
// The raw cell-by-cell shape (strings everywhere) is validated by
// importRowSchema; the typed payload is then handed to parse-row for
// activity / opportunity expansion.

import { z } from "zod";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import { nameField, urlField } from "@/lib/validation/primitives";

export const importRowSchema = z.object({
  // Required.
  firstName: nameField,

  // Optional plain string fields (already trimmed). The schema lets
  // empty strings through and the per-row parser turns them into NULL.
  lastName: nameField.or(z.literal("")).optional().nullable(),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .or(z.literal(""))
    .optional()
    .nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  mobilePhone: z.string().trim().max(50).optional().nullable(),
  jobTitle: z.string().trim().max(200).optional().nullable(),
  companyName: z.string().trim().max(200).optional().nullable(),
  industry: z.string().trim().max(100).optional().nullable(),
  website: urlField.or(z.literal("")).optional().nullable(),
  linkedinUrl: urlField.or(z.literal("")).optional().nullable(),
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  status: z.enum(LEAD_STATUSES).default("new"),
  rating: z.enum(LEAD_RATINGS).default("warm"),
  source: z.enum(LEAD_SOURCES).default("import"),
  estimatedValue: z.number().finite().min(0).max(1_000_000_000).optional().nullable(),
  estimatedCloseDate: z.date().optional().nullable(),
  subject: z.string().trim().max(1000).optional().nullable(),
  description: z.string().trim().max(20_000).optional().nullable(),
  notes: z.string().optional().nullable(),
  phoneCalls: z.string().optional().nullable(),
  meetings: z.string().optional().nullable(),
  emails: z.string().optional().nullable(),
  lastActivityAt: z.date().optional().nullable(),
  oppName: z.string().trim().max(200).optional().nullable(),
  oppStage: z.string().trim().max(50).optional().nullable(),
  oppProbability: z.number().int().min(0).max(100).optional().nullable(),
  oppAmount: z.number().finite().min(0).max(1_000_000_000).optional().nullable(),
  oppOwnerEmail: z
    .string()
    .trim()
    .email()
    .or(z.literal(""))
    .optional()
    .nullable(),
  tags: z.string().trim().optional().nullable(),
  doNotContact: z.boolean().default(false),
  doNotEmail: z.boolean().default(false),
  doNotCall: z.boolean().default(false),
  ownerEmail: z
    .string()
    .trim()
    .email()
    .or(z.literal(""))
    .optional()
    .nullable(),
  externalId: z.string().trim().max(120).optional().nullable(),
});

export type ImportRowInput = z.infer<typeof importRowSchema>;
