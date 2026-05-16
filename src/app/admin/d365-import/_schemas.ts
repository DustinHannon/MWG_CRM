import "server-only";
import { z } from "zod";
import { D365_ENTITY_TYPES } from "@/lib/d365/types";
import { D365_HALT_REASONS } from "@/lib/d365/audit-events";

/**
 * Zod schemas for every server-action FormData input on
 * the D365 import surface. Each schema parses the raw `Record<string,
 * string>` produced by `formToObject` (entries that come in as `""`
 * are normalised to `undefined`).
 *
 * Server actions in `actions.ts` use `safeParse` and translate failures
 * via `ValidationError` so the UI surfaces a clean public message.
 */

const uuid = z.string().uuid();

/**
 * Helper: Next.js form `FormData` always emits string values. We
 * normalise empty strings to `undefined` before parse so optional
 * fields don't have to special-case `""`.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      obj[k] = trimmed;
      continue;
    }
    obj[k] = v;
  }
  return obj;
}

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

/**
 * Quick-pull (one of nine entity buttons). Creates the run if none
 * exists for that entity at status='created'/'reviewing', and pulls
 * the first/next batch.
 */
export const quickPullSchema = z.object({
  entityType: entityTypeSchema,
});

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
