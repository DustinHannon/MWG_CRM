import "server-only";

import type { importRecords } from "@/db/schema/d365-imports";

/**
 * pure-function halt detectors for the import pipeline.
 *
 * Each detector inspects an in-memory batch of `import_records` (or a
 * single record) and decides whether the run should pause for review.
 * Detectors are deliberately stateless and side-effect free so they
 * can be unit-tested without a database.
 *
 * Halt taxonomy (see §4.5 of brief / `D365_HALT_REASONS`):
 *
 * H-1 D365_UNREACHABLE — detected at fetch-time inside
 * `pullBatch` from retry exhaustion;
 * NOT a pure function (lives there).
 * H-2 UNMAPPED_PICKLIST — `detectUnmappedPicklist`
 * H-3 HIGH_VOLUME_CONFLICT — `detectHighVolumeConflict` (>30%)
 * H-4 OWNER_JIT_FAILURE — `detectOwnerJitFailure` (>=5 fail)
 * H-5 VALIDATION_REGRESSION — `detectValidationRegression` (>=10 warn)
 *
 * All thresholds are defined here as named constants so future
 * tuning needs to land in exactly one place (and so the test suite
 * can import them).
 */

/* -------------------------------------------------------------------------- *
 * Threshold constants *
 * -------------------------------------------------------------------------- */

export const HIGH_VOLUME_CONFLICT_THRESHOLD_PERCENT = 30;
export const OWNER_JIT_FAILURE_THRESHOLD = 5;
export const VALIDATION_REGRESSION_THRESHOLD = 10;

/* -------------------------------------------------------------------------- *
 * Working types *
 * -------------------------------------------------------------------------- */

/**
 * Subset of `import_records` columns the detectors actually read.
 * Matches the Drizzle row type so a `.select()` result drops in
 * directly without coercion. Inlined to keep these helpers
 * import-cycle-free with the orchestrator.
 */
export type ImportRecordForDetect = Pick<
  typeof importRecords.$inferSelect,
  "id" | "validationWarnings" | "conflictWith" | "mappedPayload"
>;

/**
 * Shape of a single entry in `validation_warnings`. The entity
 * mappers emit objects of this shape; we only depend on the `code`
 * field here, but the full shape is documented for clarity.
 */
export interface ValidationWarning {
  field?: string;
  code: string;
  message?: string;
  /** Optional raw value that triggered the warning. Used by the
   * unmapped-picklist detector to surface the offending option-set
   * value to the reviewer. */
  value?: string | number | null;
}

export interface DetectorResult {
  halt: boolean;
  threshold: number;
}

export interface HighVolumeConflictResult extends DetectorResult {
  matchedCount: number;
  totalCount: number;
  /** Percentage (0-100) of records flagged as conflicts. */
  matchedPercent: number;
}

export interface OwnerJitFailureResult extends DetectorResult {
  failureCount: number;
}

export interface ValidationRegressionResult extends DetectorResult {
  warningCount: number;
}

export interface UnmappedPicklistResult {
  halt: boolean;
  field?: string;
  value?: string | number;
  message?: string;
}

/* -------------------------------------------------------------------------- *
 * Internal helpers *
 * -------------------------------------------------------------------------- */

function asWarnings(raw: unknown): ValidationWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (w): w is ValidationWarning =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as { code?: unknown }).code === "string",
  );
}

function hasWarningCode(record: ImportRecordForDetect, code: string): boolean {
  return asWarnings(record.validationWarnings).some((w) => w.code === code);
}

/* -------------------------------------------------------------------------- *
 * H-3 — High-volume conflict *
 * -------------------------------------------------------------------------- */

/**
 * Halts when more than 30% of the batch matched an existing local
 * record (i.e. dedup found duplicates). Indicates a likely
 * misconfigured re-import or a scope bug pulling already-imported data.
 */
export function detectHighVolumeConflict(
  records: ImportRecordForDetect[],
): HighVolumeConflictResult {
  const totalCount = records.length;
  const matchedCount = records.reduce(
    (acc, r) => (r.conflictWith ? acc + 1 : acc),
    0,
  );
  const matchedPercent =
    totalCount === 0 ? 0 : (matchedCount / totalCount) * 100;
  return {
    halt:
      totalCount > 0 && matchedPercent > HIGH_VOLUME_CONFLICT_THRESHOLD_PERCENT,
    matchedCount,
    totalCount,
    matchedPercent,
    threshold: HIGH_VOLUME_CONFLICT_THRESHOLD_PERCENT,
  };
}

/* -------------------------------------------------------------------------- *
 * H-4 — Owner JIT failure *
 * -------------------------------------------------------------------------- */

/**
 * Counts records the mapper flagged with `code: 'owner_unresolvable'`
 * the marker `owner-mapping.ts` emits when neither an existing user,
 * a JIT-provisionable Entra account, nor the configured default owner
 * could resolve.
 *
 * Note: routine fallback to the configured default-owner is NOT a
 * failure — that's a successful resolution per Q-05. Only true
 * unresolvable rows are counted here. Q-05 also locks in a separate
 * threshold on default-owner usage at §4.5 H-4 (≥5 fallbacks) which
 * surfaces via `code: 'owner_default_owner_used'` — we treat both
 * markers as equivalent triggers here so the threshold is enforced
 * regardless of which marker the mapper emits.
 */
export function detectOwnerJitFailure(
  records: ImportRecordForDetect[],
): OwnerJitFailureResult {
  const failureCount = records.reduce((acc, r) => {
    const codes = asWarnings(r.validationWarnings).map((w) => w.code);
    return codes.includes("owner_unresolvable") ||
      codes.includes("owner_default_owner_used")
      ? acc + 1
      : acc;
  }, 0);
  return {
    halt: failureCount >= OWNER_JIT_FAILURE_THRESHOLD,
    failureCount,
    threshold: OWNER_JIT_FAILURE_THRESHOLD,
  };
}

/* -------------------------------------------------------------------------- *
 * H-5 — Validation regression *
 * -------------------------------------------------------------------------- */

/**
 * Counts records carrying any non-empty validation warnings. A spike
 * here means a schema drift or a mapper bug — we pause for human
 * review rather than commit dirty data.
 *
 * `owner_default_owner_used` is excluded: a default-owner fallback is
 * an expected, resolvable condition (common in legacy data with
 * former-employee owners), not a regression. It has its own
 * batch-level gate via `detectOwnerJitFailure`; counting it here too
 * would false-trip the regression halt on otherwise-clean imports.
 */
export function detectValidationRegression(
  records: ImportRecordForDetect[],
): ValidationRegressionResult {
  const warningCount = records.reduce((acc, r) => {
    const warnings = asWarnings(r.validationWarnings).filter(
      (w) => w.code !== "owner_default_owner_used",
    );
    return warnings.length > 0 ? acc + 1 : acc;
  }, 0);
  return {
    halt: warningCount >= VALIDATION_REGRESSION_THRESHOLD,
    warningCount,
    threshold: VALIDATION_REGRESSION_THRESHOLD,
  };
}

/* -------------------------------------------------------------------------- *
 * H-2 — Unmapped picklist *
 * -------------------------------------------------------------------------- */

/**
 * Per-record check: does this row carry a warning marker indicating
 * a D365 option-set value that has no mapping in the registry?
 *
 * The mapper is expected to emit:
 * { field: 'leadsourcecode', code: 'unmapped_picklist', value: 12 }
 *
 * Halt fires on the FIRST occurrence — picklist gaps need explicit
 * registry updates before commit, not threshold tolerance.
 */
export function detectUnmappedPicklist(
  record: ImportRecordForDetect,
): UnmappedPicklistResult {
  const warnings = asWarnings(record.validationWarnings);
  const hit = warnings.find((w) => w.code === "unmapped_picklist");
  if (!hit) return { halt: false };
  return {
    halt: true,
    field: hit.field,
    value:
      typeof hit.value === "string" || typeof hit.value === "number"
        ? hit.value
        : undefined,
    message: hit.message,
  };
}

/**
 * Batch-level convenience around `detectUnmappedPicklist`. Returns
 * the first offending record so the orchestrator can surface a
 * specific record/field/value to the reviewer.
 */
export function detectUnmappedPicklistInBatch(
  records: ImportRecordForDetect[],
): UnmappedPicklistResult & { recordId?: string } {
  for (const r of records) {
    const result = detectUnmappedPicklist(r);
    if (result.halt) return { ...result, recordId: r.id };
  }
  return { halt: false };
}

/* -------------------------------------------------------------------------- *
 * Aggregate runner *
 * -------------------------------------------------------------------------- */

/** Re-export the canonical halt-reason strings via the audit-events module
 * so callers don't accidentally hardcode strings here. */
export { D365_HALT_REASONS } from "./audit-events";
export type { D365HaltReason } from "./audit-events";

/**
 * Optional helper: run every batch-level detector in priority order and
 * return the first halt that fires (or `null` for proceed). Priority
 * matches the brief's H-2 → H-3 → H-4 → H-5 ordering after H-1 is
 * cleared at the fetch layer.
 */
export type BatchHalt =
  | {
      reason: "unmapped_picklist";
      detail: UnmappedPicklistResult & { recordId?: string };
    }
  | { reason: "high_volume_conflict"; detail: HighVolumeConflictResult }
  | { reason: "owner_jit_failure"; detail: OwnerJitFailureResult }
  | { reason: "validation_regression"; detail: ValidationRegressionResult };

export function detectBatchHalt(
  records: ImportRecordForDetect[],
): BatchHalt | null {
  const picklist = detectUnmappedPicklistInBatch(records);
  if (picklist.halt) return { reason: "unmapped_picklist", detail: picklist };

  const conflict = detectHighVolumeConflict(records);
  if (conflict.halt)
    return { reason: "high_volume_conflict", detail: conflict };

  const owner = detectOwnerJitFailure(records);
  if (owner.halt) return { reason: "owner_jit_failure", detail: owner };

  const validation = detectValidationRegression(records);
  if (validation.halt)
    return { reason: "validation_regression", detail: validation };

  return null;
}

/* Hint for hover docs on `hasWarningCode` (used by future detectors). */
void hasWarningCode;
