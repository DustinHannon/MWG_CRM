import { z } from "zod";
import {
  REPORT_ENTITY_TYPES,
  REPORT_METRIC_FUNCTIONS,
  REPORT_VISUALIZATIONS,
} from "@/db/schema/saved-reports";

/**
 * Phase 11 — Zod request schemas for the report API surface.
 *
 * Kept in a separate file from `schemas.ts` (which holds entity-field
 * metadata) to avoid bundling Zod into client components that only need
 * the field metadata.
 */

const FILTER_LEAF = z
  .object({
    eq: z.unknown().optional(),
    ilike: z.string().optional(),
    gte: z.union([z.string(), z.number()]).optional(),
    lte: z.union([z.string(), z.number()]).optional(),
    gt: z.union([z.string(), z.number()]).optional(),
    lt: z.union([z.string(), z.number()]).optional(),
    in: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const reportFiltersSchema = z.record(z.string(), FILTER_LEAF);

export const reportMetricSchema = z.object({
  fn: z.enum(REPORT_METRIC_FUNCTIONS),
  field: z.string().optional(),
  alias: z.string().min(1).max(64),
});

/** Full saved-report definition payload, used by create/update + preview. */
export const reportDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  entityType: z.enum(REPORT_ENTITY_TYPES),
  fields: z.array(z.string()).max(40).default([]),
  filters: reportFiltersSchema.default({}),
  groupBy: z.array(z.string()).max(2).default([]),
  metrics: z.array(reportMetricSchema).max(6).default([]),
  visualization: z.enum(REPORT_VISUALIZATIONS).default("table"),
  isShared: z.boolean().default(false),
});

export type ReportDefinitionInput = z.infer<typeof reportDefinitionSchema>;

export const reportUpdateSchema = reportDefinitionSchema.partial();
export type ReportUpdateInput = z.infer<typeof reportUpdateSchema>;

export const reportPreviewSchema = reportDefinitionSchema;
