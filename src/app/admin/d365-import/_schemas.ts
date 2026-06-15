import "server-only";
import { z } from "zod";
import { D365_ENTITY_TYPES } from "@/lib/d365/types";
import { D365_HALT_REASONS } from "@/lib/d365/audit-events";

/**
 * Zod schemas for every server-action FormData input on
 * the D365 import surface. Each schema parses the `Record<string,
 * unknown>` produced by `formDataToObject` inside `parseFormOrThrow`
 * (`@/lib/forms/form-data`), which translates parse failures into the
 * standard `ValidationError` envelope; actions.ts does not call
 * `safeParse` directly.
 */

const uuid = z.string().uuid();

const entityTypeSchema = z.enum(D365_ENTITY_TYPES);

/**
 * Scope shape used to seed `import_runs.scope`.
 *
 * { filter: { modifiedSince: ISO }, includeChildren: bool }
 *
 * The advanced-modal form serialises one record per field. We
 * accept `modifiedSince` as a date-only string (yyyy-mm-dd) and
 * coerce to a full ISO string before persistence. `activeOnly`
 * collapses to a `statecode=0` filter for entities that have it.
 */
export const createRunSchema = z.object({
  entityType: entityTypeSchema,
  modifiedSince: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "Date must be YYYY-MM-DD")
    .optional(),
  activeOnly: z
    .union([z.literal("on"), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
  includeChildren: z
    .union([z.literal("on"), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;

/** Pull next batch on an existing run. */
export const pullNextBatchSchema = z.object({
  runId: uuid,
});

export const approveRecordSchema = z.object({
  recordId: uuid,
});

export const rejectRecordSchema = z.object({
  recordId: uuid,
  reason: z.string().trim().min(1).max(500).optional(),
});

export const editRecordFieldsSchema = z.object({
  recordId: uuid,
  /**
   * JSON-serialised partial mappedPayload. Caller stringifies in the
   * client component; we re-parse to enforce {object} shape.
   */
  mappedPayloadJson: z.string().min(2).max(64_000),
});

export const setConflictResolutionSchema = z.object({
  recordId: uuid,
  resolution: z.enum([
    "none",
    "dedup_skip",
    "dedup_merge",
    "dedup_overwrite",
    "manual_resolved",
  ]),
});

export const commitBatchSchema = z.object({
  batchId: uuid,
});

export const abortRunSchema = z.object({
  runId: uuid,
});

const haltReasonSchema = z.enum([
  D365_HALT_REASONS.D365_UNREACHABLE,
  D365_HALT_REASONS.UNMAPPED_PICKLIST,
  D365_HALT_REASONS.HIGH_VOLUME_CONFLICT,
  D365_HALT_REASONS.OWNER_JIT_FAILURE,
  D365_HALT_REASONS.VALIDATION_REGRESSION,
  // The bad-lead-volume halt already fires today (map-batch's
  // garbage-volume gate) but was missing from this enum, so
  // resumeRunAction's safeParse rejected `reason: "bad_lead_volume"`
  // — the operator could not resume a bad-lead-volume-halted run via
  // the UI. resume-run's ALLOWED_RESOLUTIONS already handles it.
  D365_HALT_REASONS.BAD_LEAD_VOLUME,
  // Pull-time child-collection truncation halt. resumeRunAction maps it
  // to a `retry` resolution (resume-run's ALLOWED_RESOLUTIONS allows
  // only retry here); without this enum entry the operator could not
  // resume a truncation-halted run via the UI.
  D365_HALT_REASONS.CHILD_COLLECTION_TRUNCATED,
]);

/**
 * Resume-run resolution payload. Shape varies by halt reason — the
 * schema is a discriminated union over `reason`.
 */
export const resumeRunSchema = z.object({
  runId: uuid,
  reason: haltReasonSchema,
  /**
   * For `high_volume_conflict` the reviewer picks one of:
   * skip / overwrite / merge.
   * Other halt reasons have no per-reason payload — the user clicks
   * "Resume after fix" / "Use default owner and resume".
   */
  conflictResolution: z
    .enum(["dedup_skip", "dedup_overwrite", "dedup_merge"])
    .optional(),
});

export const markCompleteSchema = z.object({
  runId: uuid,
});

/**
 * Reset a batch stuck in `committing` (commit-batch's transient lock
 * state) back to `reviewing`. Only used after a hard function kill
 * (SIGKILL / OOM / wall-clock / deploy recycle) left the row in
 * `committing` with no JS catch to roll it back. The action applies
 * an atomic `WHERE status = 'committing'` guard so a still-running
 * commit that finishes between inspection and click is not clobbered.
 */
export const resetStuckBatchSchema = z.object({
  batchId: uuid,
});
