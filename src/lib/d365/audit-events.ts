import "server-only";

/**
 * Phase 23 — registered taxonomy of `d365.import.*` audit events.
 *
 * Every meaningful state transition in the import pipeline emits one
 * of these via `writeAudit`. The §11 acceptance includes a production
 * verification that all 14 names appear in `audit_log` within 7 days
 * of go-live; missing names are P0 findings.
 *
 * Sub-agents reference these constants — no string literals at emit
 * sites — so a typo in one place fails typecheck instead of silently
 * breaking SOC 2 forensic trail.
 */
export const D365_AUDIT_EVENTS = {
  RUN_CREATED: "d365.import.run.created",
  RUN_HALTED: "d365.import.run.halted",
  RUN_RESUMED: "d365.import.run.resumed",
  RUN_ABORTED: "d365.import.run.aborted",
  RUN_COMPLETED: "d365.import.run.completed",
  BATCH_FETCHED: "d365.import.batch.fetched",
  BATCH_REVIEWED: "d365.import.batch.reviewed",
  BATCH_APPROVED: "d365.import.batch.approved",
  BATCH_REJECTED: "d365.import.batch.rejected",
  BATCH_COMMITTED: "d365.import.batch.committed",
  RECORD_FLAGGED_CONFLICT: "d365.import.record.flagged_conflict",
  RECORD_APPROVED: "d365.import.record.approved",
  RECORD_REJECTED: "d365.import.record.rejected",
  RECORD_COMMITTED: "d365.import.record.committed",
  RECORD_SKIPPED: "d365.import.record.skipped",
  CONFIG_CHANGED: "d365.import.config.changed",
  OWNER_JIT_PROVISIONED: "d365.import.owner.jit_provisioned",
} as const;

export type D365AuditEvent =
  (typeof D365_AUDIT_EVENTS)[keyof typeof D365_AUDIT_EVENTS];

/**
 * Halt reason taxonomy (see §4.5 of brief). Persisted in
 * `import_runs.notes` and emitted with `RUN_HALTED` events.
 */
export const D365_HALT_REASONS = {
  D365_UNREACHABLE: "d365_unreachable",
  UNMAPPED_PICKLIST: "unmapped_picklist",
  HIGH_VOLUME_CONFLICT: "high_volume_conflict",
  OWNER_JIT_FAILURE: "owner_jit_failure",
  VALIDATION_REGRESSION: "validation_regression",
} as const;

export type D365HaltReason =
  (typeof D365_HALT_REASONS)[keyof typeof D365_HALT_REASONS];

/**
 * Realtime broadcast events on `d365-import-run:<runId>` channel.
 * Every write at fetch / map / commit phase emits one of these so
 * the live progress panel updates within 2s without page reload.
 */
export const D365_REALTIME_EVENTS = {
  FETCHING_STARTED: "fetching.started",
  FETCHING_PROGRESS: "fetching.progress",
  FETCHING_COMPLETED: "fetching.completed",
  MAPPING_STARTED: "mapping.started",
  MAPPING_PROGRESS: "mapping.progress",
  MAPPING_COMPLETED: "mapping.completed",
  COMMITTING_STARTED: "committing.started",
  COMMITTING_PROGRESS: "committing.progress",
  COMMITTING_COMPLETED: "committing.completed",
  ERROR: "error",
  HALTED: "halted",
  RESUMED: "resumed",
} as const;

export type D365RealtimeEvent =
  (typeof D365_REALTIME_EVENTS)[keyof typeof D365_REALTIME_EVENTS];
