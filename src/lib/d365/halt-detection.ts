import "server-only";

import type { importRecords } from "@/db/schema/d365-imports";
// Imported from the leaf `./mapping/children` (not the `./mapping` barrel)
// so this stays import-cycle-free with the mappers/orchestrator.
import { isChildWarning } from "./mapping/children";

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
 * H-4 OWNER_JIT_FAILURE — `detectOwnerJitFailure` (>30% & >=5)
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
/**
 * Absolute floor for the owner-JIT-failure halt. A batch must carry at
 * least this many default-owner / unresolvable rows before the halt can
 * fire — below this, the sample is too small for the proportion to be
 * informative (mirrors the per-batch garbage-volume sample gate).
 */
export const OWNER_JIT_FAILURE_THRESHOLD = 5;
/**
 * Proportion gate for the owner-JIT-failure halt. The halt fires only
 * when MORE than this percentage of the batch fell back to the default
 * owner (or was unresolvable) AND the absolute floor is met. A handful
 * of legitimate former-employee fallbacks in an otherwise-clean batch
 * is expected and must NOT halt the run; a batch DOMINATED by them
 * signals a systemic problem (e.g. a regressed owner lookup or a
 * known-bad import era) worth pausing for. Mirrors the ratio-based
 * `shouldHaltOnGarbageVolume` precedent.
 */
export const OWNER_JIT_FAILURE_THRESHOLD_PERCENT = 30;
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
  totalCount: number;
  /** Percentage (0-100) of the batch that fell back to default owner. */
  failurePercent: number;
  /** Proportion gate (percent) that must be exceeded for the halt. */
  thresholdPercent: number;
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

/**
 * ROOT-scoped warnings only — drops CHILD-origin warnings (their `field`
 * is prefixed with `CHILD_WARNING_FIELD_PREFIX`). The run-wide halt gates
 * (unmapped-picklist, validation-regression) must NOT fire on a bad child
 * (an unmapped activity picklist, an "Untitled task" default): a child is
 * persisted/visible non-fatally but never halts the run — children.ts's
 * "a bad child must not sink the root graph" contract.
 */
function rootWarnings(record: ImportRecordForDetect): ValidationWarning[] {
  return asWarnings(record.validationWarnings).filter(
    (w) => typeof w.field !== "string" || !isChildWarning(w.field),
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
 * Counts records that fell back to the default owner
 * (`owner_default_owner_used`, the marker `map-batch` emits) or that a
 * mapper flagged as truly `owner_unresolvable`.
 *
 * Halt semantics (proportion-gated, not a bare count): a default-owner
 * fallback is an EXPECTED, resolvable condition — former-employee-owned
 * rows are common in legacy data and Q-05 deliberately routes them to
 * the configured default owner. A handful of such fallbacks in a clean
 * batch must NOT halt the run, so the halt fires only when the fallback
 * rate exceeds `OWNER_JIT_FAILURE_THRESHOLD_PERCENT` AND the absolute
 * floor `OWNER_JIT_FAILURE_THRESHOLD` is met (the floor avoids
 * over-reacting to tiny batches). A batch DOMINATED by default-owner
 * usage signals a systemic problem (e.g. a regressed owner lookup or a
 * known-bad import era) worth pausing for. This mirrors the ratio-based
 * `shouldHaltOnGarbageVolume` precedent and aligns with
 * `detectValidationRegression`, which excludes the same marker from the
 * regression count.
 */
export function detectOwnerJitFailure(
  records: ImportRecordForDetect[],
): OwnerJitFailureResult {
  const totalCount = records.length;
  const failureCount = records.reduce((acc, r) => {
    const codes = asWarnings(r.validationWarnings).map((w) => w.code);
    return codes.includes("owner_unresolvable") ||
      codes.includes("owner_default_owner_used")
      ? acc + 1
      : acc;
  }, 0);
  const failurePercent =
    totalCount === 0 ? 0 : (failureCount / totalCount) * 100;
  return {
    halt:
      failureCount >= OWNER_JIT_FAILURE_THRESHOLD &&
      failurePercent > OWNER_JIT_FAILURE_THRESHOLD_PERCENT,
    failureCount,
    totalCount,
    failurePercent,
    threshold: OWNER_JIT_FAILURE_THRESHOLD,
    thresholdPercent: OWNER_JIT_FAILURE_THRESHOLD_PERCENT,
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
    // Root-scoped warnings only — child warnings are non-fatal and must
    // not inflate the regression count (see rootWarnings).
    const warnings = rootWarnings(r).filter(
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
  // Root-scoped only: a child's unmapped picklist must not halt the run.
  const warnings = rootWarnings(record);
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
