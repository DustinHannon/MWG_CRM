import "server-only";

/**
 * registered taxonomy of `d365.import.*` audit events.
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
  // explicit *_FAILED events so the forensic trail
  // captures every error class without relying on logger output. Each
  // emit site pairs the event with the row-level `status='failed'`
  // update so the audit log and the records table agree.
  RECORD_COMMIT_FAILED: "d365.import.record.commit_failed",
  RECORD_VALIDATION_FAILED: "d365.import.record.validation_failed",
  /** Fetch failed in a non-halt way (programmer error, parse error). */
  FETCH_FAILED: "d365.import.fetch.failed",
  /** Auth (MSAL token acquisition) failed. */
  AUTH_FAILED: "d365.import.auth.failed",
  /** JIT owner provisioning failed for a record. */
  OWNER_JIT_FAILED: "d365.import.owner.jit_failed",
  /**
   * commit-batch tried to resolve a related D365 GUID (e.g.
   * contact._parentcustomerid_value, account._parentaccountid_value,
   * account._primarycontactid_value) to a local UUID via external_ids
   * but the foreign record hasn't been imported yet. The FK is left
   * null on the committed row; a re-import will resolve once the
   * foreign record lands.
   */
  RECORD_FK_UNRESOLVED: "d365.import.record.fk_unresolved",
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
  /**
   * > 50% of a batch verdicts as `garbage` from the data-quality
   * heuristics in `quality.ts`. Almost certainly a known-bad import
   * era from the legacy CRM — admin reviews the batch before
   * silent-skip locks in.
   */
  BAD_LEAD_VOLUME: "bad_lead_volume",
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
