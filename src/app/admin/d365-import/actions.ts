"use server";

import { revalidatePath } from "next/cache";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { AUDIT_EVENTS } from "@/lib/audit/events";
import { D365_AUDIT_EVENTS } from "@/lib/d365/audit-events";
import { pullNextBatch } from "@/lib/d365/pull-batch";
import { mapBatch } from "@/lib/d365/map-batch";
import { commitBatch, reconcileRunFks } from "@/lib/d365/commit-batch";
import { resumeRun, type ResumeResolution } from "@/lib/d365/resume-run";
import {
  D365_ROOT_TYPES,
  isD365RootType,
  type D365RootType,
} from "@/lib/d365/queries";
import type { D365EntityType } from "@/lib/d365/types";
import { parseFormOrThrow } from "@/lib/forms/form-data";
import {
  abortRunSchema,
  approveRecordSchema,
  commitBatchSchema,
  createRunSchema,
  editRecordFieldsSchema,
  markCompleteSchema,
  pullNextBatchSchema,
  rejectRecordSchema,
  resetStuckBatchSchema,
  resumeRunSchema,
  setConflictResolutionSchema,
} from "./_schemas";

/**
 * admin server actions for the D365 import surface.
 *
 * Every action is admin-gated and wrapped in `withErrorBoundary` so
 * failures surface as a clean public message + request id without
 * leaking stack traces. Mutations that change run/batch/record state
 * write to `audit_log` via `writeAudit`.
 *
 * The pipeline helpers (`pullNextBatch`, `mapBatch`, `commitBatch`,
 * `resumeRun`) are statically imported from `@/lib/d365`; each action
 * loads records, calls the relevant pipeline helper, audits the state
 * transition, and revalidates the affected admin paths.
 */

/* -------------------------------------------------------------------------- *
 * Helpers *
 * -------------------------------------------------------------------------- */

/**
 * Resolve the effective `modifiedSince` ISO string for a run scope.
 * An explicit `yyyy-mm-dd` from the operator is widened to midnight UTC;
 * absent input defaults to two years ago (the redesign's default window).
 */
function resolveModifiedSinceIso(modifiedSince: string | undefined): string {
  if (modifiedSince) return `${modifiedSince}T00:00:00.000Z`;
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString();
}

/**
 * Build the `import_runs.scope` JSONB for a ROOT-AGGREGATE run.
 *
 * Root-aggregate model: the unit of work is one ROOT entity (lead /
 * contact / account / opportunity) WITH its full child graph (tasks /
 * phonecalls / appointments / emails / notes). Children ALWAYS travel
 * with their root — there is no per-run "include children" choice, so
 * the legacy `includeChildren` scope key is gone (pull-batch always
 * drains the child graph).
 *
 * Scope shape consumed by `scopeToFetchOpts` in pull-batch.ts:
 *   { filter: { modifiedSince: ISO, statecode?: number[] } }
 *
 * `statecode` presence is authoritative in pull-batch/queries: an absent
 * key applies the per-entity active-only default; `[0]` = active only;
 * `[]` = all states. We always write the key explicitly so an
 * "all states" run is not silently narrowed by the per-entity default.
 */
function buildRootRunScope(
  modifiedSince: string | undefined,
  activeOnly: boolean,
): Record<string, unknown> {
  return {
    filter: {
      modifiedSince: resolveModifiedSinceIso(modifiedSince),
      statecode: activeOnly ? [0] : [],
    },
  };
}

/**
 * Translate the resume form-data shape (`reason` + optional
 * `conflictResolution`) into the `ResumeResolution` discriminated
 * union that `resumeRun` consumes, so the action contract stays
 * form-friendly.
 */
function mapResumeFormToResolution(
  reason: string,
  conflictResolution: string | undefined,
): ResumeResolution {
  switch (reason) {
    case "d365_unreachable":
      return { kind: "retry" };
    case "child_collection_truncated":
      // Truncation halt resolves by re-pulling the page (resume-run's
      // ALLOWED_RESOLUTIONS permits only `retry` here).
      return { kind: "retry" };
    case "unmapped_picklist":
      return { kind: "fix_picklist" };
    case "owner_jit_failure":
      return { kind: "use_default_owner" };
    case "validation_regression":
      return { kind: "open_for_review" };
    case "high_volume_conflict": {
      const behavior =
        conflictResolution === "dedup_skip"
          ? "skip"
          : conflictResolution === "dedup_overwrite"
            ? "overwrite"
            : "merge";
      return { kind: "apply_dedup_default", defaultBehavior: behavior };
    }
    case "bad_lead_volume":
      // Bad-lead-volume halts only resolve via human review of the
      // auto-skipped batch (resume-run's ALLOWED_RESOLUTIONS allows
      // only open_for_review here). Explicit so the resolution isn't
      // an undocumented fall-through to the default.
      return { kind: "open_for_review" };
    default:
      return { kind: "open_for_review" };
  }
}

/* -------------------------------------------------------------------------- *
 * Run actions *
 * -------------------------------------------------------------------------- */

/**
 * Create one ROOT-AGGREGATE import run.
 *
 * The run roots on ONE of the four root types (lead / contact / account /
 * opportunity); its child graph (tasks / phonecalls / appointments /
 * emails / notes) is ALWAYS pulled with it. Child types
 * (task/phonecall/appointment/email/annotation) cannot be rooted
 * standalone — pull-batch's `reserveNextBatch` also rejects them, but we
 * reject here too so an invalid run never persists. (Originated
 * opportunities import via their own opportunity root run, not as a child
 * of a lead.)
 *
 * For the "import all four roots in dependency order" wizard path, call
 * {@link importAllRootsAction}.
 */
export async function createRunAction(
  formData: FormData,
): Promise<ActionResult<{ runId: string }>> {
  return withErrorBoundary(
    { action: "d365.import.run.create" },
    async () => {
      const user = await requireAdmin();
      const input = parseFormOrThrow(createRunSchema, formData);

      // Root-aggregate: only the four root types are valid units of work.
      // createRunSchema's enum still spans all nine D365 entity types for
      // back-compat (it lives in _schemas.ts, edited in the UI slice), so
      // gate to root types here. `includeChildren` from the legacy form is
      // ignored — children always come.
      if (!isD365RootType(input.entityType as D365EntityType)) {
        throw new ValidationError(
          "Import runs must root on lead, contact, account, or opportunity. Child records (tasks, calls, appointments, emails, notes) are imported automatically with their root.",
        );
      }
      const rootType = input.entityType as D365RootType;

      const scope = buildRootRunScope(input.modifiedSince, input.activeOnly);

      const [row] = await db
        .insert(importRuns)
        .values({
          source: "d365",
          entityType: rootType,
          status: "created",
          scope,
          createdById: user.id,
        })
        .returning({ id: importRuns.id });

      if (!row) {
        throw new ConflictError("Could not create run.");
      }

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RUN_CREATED,
        targetType: "import_run",
        targetId: row.id,
        after: { entityType: rootType, scope },
      });

      revalidatePath("/admin/d365-import");
      return { runId: row.id };
    },
  );
}

/**
 * "Import everything": create one ROOT-AGGREGATE run per root type, seeded
 * in cross-root dependency order (account → contact → lead → opportunity,
 * from {@link D365_ROOT_TYPES}) so a dependent root's cross-root parents
 * already exist in `external_ids` by the time it commits. Each run shares
 * the same `modifiedSince` + `activeOnly` scope and pulls its full child
 * graph automatically.
 *
 * Runs are created in `status='created'`; the wizard's commit/progress step
 * pulls + commits each, in order. Cross-root FKs that still land null
 * (a parent in a sibling run committed later) are swept by
 * `reconcileRunFks` when each run is marked complete.
 *
 * Idempotency note: this always creates a fresh set of runs (no reuse of
 * existing open runs) — the wizard is the single entry point and an
 * operator re-clicking "import all" intends a new pass; duplicate entity
 * writes are still prevented downstream by external_ids + the dedup
 * arbiters, so a re-run reconciles rather than duplicates.
 */
export async function importAllRootsAction(
  formData: FormData,
): Promise<ActionResult<{ runIds: string[] }>> {
  return withErrorBoundary(
    { action: "d365.import.run.import_all_roots" },
    async () => {
      const user = await requireAdmin();
      const input = parseFormOrThrow(createRunSchema, formData);

      const scope = buildRootRunScope(input.modifiedSince, input.activeOnly);

      // Atomic: insert all four runs in ONE transaction (dependency order
      // so persisted createdAt ordering matches the commit order the
      // wizard walks). A mid-loop failure rolls back every insert rather
      // than leaving orphan empty runs. Audits are emitted AFTER the tx
      // commits (writeAudit is best-effort and uses the global connection;
      // emitting post-commit avoids orphan audit rows on rollback).
      const created = await db.transaction(async (tx) => {
        const rows: Array<{ id: string; entityType: D365RootType }> = [];
        for (const rootType of D365_ROOT_TYPES) {
          const [row] = await tx
            .insert(importRuns)
            .values({
              source: "d365",
              entityType: rootType,
              status: "created",
              scope,
              createdById: user.id,
            })
            .returning({ id: importRuns.id });
          if (!row) {
            throw new ConflictError(
              `Could not create the ${rootType} import run.`,
            );
          }
          rows.push({ id: row.id, entityType: rootType });
        }
        return rows;
      });

      for (const row of created) {
        await writeAudit({
          actorId: user.id,
          action: D365_AUDIT_EVENTS.RUN_CREATED,
          targetType: "import_run",
          targetId: row.id,
          after: { entityType: row.entityType, scope, viaImportAll: true },
        });
      }

      revalidatePath("/admin/d365-import");
      return { runIds: created.map((r) => r.id) };
    },
  );
}

export async function pullNextBatchAction(
  formData: FormData,
): Promise<ActionResult<{ batchId: string | null }>> {
  return withErrorBoundary(
    { action: "d365.import.batch.pull_next" },
    async () => {
      const user = await requireAdmin();
      const { runId } = parseFormOrThrow(pullNextBatchSchema, formData);

      const [run] = await db
        .select({ id: importRuns.id, status: importRuns.status })
        .from(importRuns)
        .where(eq(importRuns.id, runId))
        .limit(1);
      if (!run) throw new NotFoundError("import run");

      if (
        run.status === "aborted" ||
        run.status === "completed" ||
        run.status === "paused_for_review"
      ) {
        throw new ValidationError(
          `Run is ${run.status} — cannot pull next batch.`,
        );
      }

      let batchId: string | null = null;
      try {
        const out = await pullNextBatch(runId, user.id);
        batchId = out.batchId;
      } catch (err) {
        logger.error("d365.pull_batch.failed", {
          runId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (batchId) {
        await writeAudit({
          actorId: user.id,
          action: AUDIT_EVENTS.D365_BATCH_PULL_NEXT,
          targetType: "import_run",
          targetId: runId,
          after: { batchId, priorStatus: run.status },
        });
      }

      if (batchId) {
        try {
          await mapBatch(batchId, user.id);
        } catch (err) {
          logger.error("d365.map_batch.failed", {
            batchId,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      revalidatePath(`/admin/d365-import/${runId}`);
      return { batchId };
    },
  );
}

export async function abortRunAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.run.abort" },
    async () => {
      const user = await requireAdmin();
      const { runId } = parseFormOrThrow(abortRunSchema, formData);

      const [run] = await db
        .select({ id: importRuns.id, status: importRuns.status })
        .from(importRuns)
        .where(eq(importRuns.id, runId))
        .limit(1);
      if (!run) throw new NotFoundError("import run");
      if (run.status === "aborted" || run.status === "completed") {
        throw new ValidationError(`Run is already ${run.status}.`);
      }

      await db
        .update(importRuns)
        .set({ status: "aborted", completedAt: new Date() })
        .where(eq(importRuns.id, runId));

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RUN_ABORTED,
        targetType: "import_run",
        targetId: runId,
        before: { status: run.status },
        after: { status: "aborted" },
      });

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${runId}`);
    },
  );
}

export async function markRunCompleteAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.run.mark_complete" },
    async () => {
      const user = await requireAdmin();
      const { runId } = parseFormOrThrow(markCompleteSchema, formData);

      const [run] = await db
        .select({ id: importRuns.id, status: importRuns.status })
        .from(importRuns)
        .where(eq(importRuns.id, runId))
        .limit(1);
      if (!run) throw new NotFoundError("import run");

      if (run.status === "completed") {
        throw new ValidationError("Run already completed.");
      }
      if (run.status === "aborted") {
        throw new ValidationError("Cannot complete an aborted run.");
      }
      // A halted (paused_for_review) run has an unresolved halt condition
      // (D365 unreachable, unmapped picklist, owner JIT failure, truncated
      // child collection, etc.). Marking it complete would bury that halt
      // and silently drop everything past the halt point. The operator
      // must Resume (resolve + continue) or Abort it first. This is the
      // run-detail completion-gate fix.
      if (run.status === "paused_for_review") {
        throw new ValidationError(
          "Run is paused for review. Resume it to resolve the halt, or abort it — it cannot be marked complete while halted.",
        );
      }

      // Refuse if any batch is still in a non-terminal state. This
      // includes `committing` (a stuck or in-flight commit must not
      // be buried) and `failed` (partial CRM writes occurred — the
      // operator must re-review and recommit before the run can be
      // considered complete). `commitBatchAction` already treats
      // `failed` as needing explicit operator action; run-completion
      // must be consistent with that.
      const blockers = await db
        .select({ id: importBatches.id, status: importBatches.status })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.runId, runId),
            inArray(importBatches.status, [
              "pending",
              "fetched",
              "reviewing",
              "approved",
              "committing",
              "failed",
            ]),
          ),
        )
        .limit(1);
      if (blockers[0]) {
        throw new ValidationError(
          "Cannot mark complete while batches are pending, in review, committing, or failed. Resolve failed or stuck batches first.",
        );
      }

      // Auto-reconcile cross-root FKs left null at commit time (a root's
      // cross-root parent landed in a later batch). Replaces the manual
      // opportunity-FK backfill button. Best-effort: a reconcile failure
      // is logged but must not block marking the run complete — the
      // sweep is idempotent and re-runnable.
      try {
        await reconcileRunFks(runId, user.id);
      } catch (err) {
        logger.warn("d365.run.reconcile_on_complete_failed", {
          runId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      await db
        .update(importRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(importRuns.id, runId));

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RUN_COMPLETED,
        targetType: "import_run",
        targetId: runId,
        before: { status: run.status },
        after: { status: "completed" },
      });

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${runId}`);
    },
  );
}

/**
 * Reset a batch stuck in `committing` back to `reviewing`.
 *
 * commit-batch flips a batch to `committing` at the start of its loop
 * and back to a terminal state (`committed` / `failed`) at the end. A
 * caught JS error rolls it back to `reviewing`, but an uncaught hard
 * kill (SIGKILL / OOM / 300s wall / deploy recycle) leaves the row in
 * `committing` permanently — `commitBatchAction` then refuses the
 * batch forever. The d365-imports schema documents this as a known
 * gap requiring a manual reset after inspection; this is that reset,
 * built in-app.
 *
 * Safety: the reset is an atomic conditional UPDATE guarded on
 * `status = 'committing'`. If a slow-but-alive commit finishes
 * between the operator's inspection and the click, the UPDATE affects
 * zero rows and we throw `ConflictError` rather than clobber it.
 */
export async function resetStuckBatchAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.batch.reset_stuck" },
    async () => {
      const user = await requireAdmin();
      const { batchId } = parseFormOrThrow(resetStuckBatchSchema, formData);

      const [batch] = await db
        .select({
          id: importBatches.id,
          runId: importBatches.runId,
          status: importBatches.status,
        })
        .from(importBatches)
        .where(eq(importBatches.id, batchId))
        .limit(1);
      if (!batch) throw new NotFoundError("import batch");
      if (batch.status !== "committing") {
        throw new ValidationError(
          `Batch is ${batch.status}, not committing — nothing to reset.`,
        );
      }

      const reset = await db
        .update(importBatches)
        .set({ status: "reviewing" })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.status, "committing"),
          ),
        )
        .returning({ id: importBatches.id });
      if (reset.length === 0) {
        throw new ConflictError(
          "Batch is no longer committing — the commit may have finished or already been reset.",
          { batchId },
        );
      }

      logger.warn("d365.batch.reset_stuck", {
        batchId,
        runId: batch.runId,
        actorId: user.id,
      });

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.BATCH_RESET_STUCK,
        targetType: "d365_import_batch",
        targetId: batchId,
        before: { status: "committing" },
        after: {
          status: "reviewing",
          resetBy: user.id,
          reason: "manual_unstick",
        },
      });

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${batch.runId}`);
    },
  );
}

export async function resumeRunAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.run.resume" },
    async () => {
      const user = await requireAdmin();
      const input = parseFormOrThrow(resumeRunSchema, formData);

      const [run] = await db
        .select({
          id: importRuns.id,
          status: importRuns.status,
        })
        .from(importRuns)
        .where(eq(importRuns.id, input.runId))
        .limit(1);
      if (!run) throw new NotFoundError("import run");
      if (run.status !== "paused_for_review") {
        throw new ValidationError(`Run is ${run.status} — nothing to resume.`);
      }

      const resolution = mapResumeFormToResolution(
        input.reason,
        input.conflictResolution,
      );
      // resumeRun writes the authoritative RUN_RESUMED audit row with
      // the real resolved nextStatus (fetching/mapping/reviewing per
      // resolution kind) and the full resolution object. No second
      // audit here — the earlier action-layer row hardcoded
      // after.status='reviewing', which contradicted the actual
      // transition for every resolution except open_for_review.
      await resumeRun(input.runId, resolution, user.id);

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${input.runId}`);
    },
  );
}

/* -------------------------------------------------------------------------- *
 * Record actions *
 * -------------------------------------------------------------------------- */

async function loadRecord(recordId: string): Promise<{
  id: string;
  batchId: string;
  status: string;
  runId: string;
  mappedPayload: unknown;
  conflictResolution: string | null;
}> {
  const rows = await db
    .select({
      id: importRecords.id,
      batchId: importRecords.batchId,
      status: importRecords.status,
      runId: importBatches.runId,
      mappedPayload: importRecords.mappedPayload,
      conflictResolution: importRecords.conflictResolution,
    })
    .from(importRecords)
    .innerJoin(importBatches, eq(importBatches.id, importRecords.batchId))
    .where(eq(importRecords.id, recordId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("import record");
  return row;
}

/**
 * Recompute the batch's approved/rejected record counters from the
 * authoritative `import_records.status` values and write them back to
 * the batch row.
 *
 * These two counters (unlike fetched/committed/failed/skipped, which
 * the pipeline helpers increment in place) only change via the
 * reviewer's per-record approve/reject decisions in the action layer.
 * Recomputing from the record rows — rather than applying a +1/-1
 * delta — keeps the stored columns correct across re-decisions (an
 * approved record later rejected, or vice-versa) and self-heals any
 * pre-existing drift, so the run/batch pages that sum these columns
 * (totalApproved / totalRejected) show the real numbers.
 */
async function recalcBatchDecisionCounts(batchId: string): Promise<void> {
  const rows = await db
    .select({ status: importRecords.status, n: count(importRecords.id) })
    .from(importRecords)
    .where(eq(importRecords.batchId, batchId))
    .groupBy(importRecords.status);

  let approved = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.status === "approved") approved = Number(r.n);
    else if (r.status === "rejected") rejected = Number(r.n);
  }

  await db
    .update(importBatches)
    .set({
      recordCountApproved: approved,
      recordCountRejected: rejected,
    })
    .where(eq(importBatches.id, batchId));
}

export async function approveRecordAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.record.approve" },
    async () => {
      const user = await requireAdmin();
      const { recordId } = parseFormOrThrow(approveRecordSchema, formData);
      const rec = await loadRecord(recordId);
      if (rec.status === "committed" || rec.status === "skipped") {
        throw new ValidationError(
          `Record is ${rec.status} — cannot change decision.`,
        );
      }
      await db
        .update(importRecords)
        .set({
          status: "approved",
          reviewerId: user.id,
          reviewedAt: new Date(),
        })
        .where(eq(importRecords.id, recordId));

      await recalcBatchDecisionCounts(rec.batchId);

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RECORD_APPROVED,
        targetType: "d365_import_record",
        targetId: recordId,
        after: { status: "approved" },
      });

      revalidatePath(`/admin/d365-import/${rec.runId}/${rec.batchId}`);
    },
  );
}

export async function rejectRecordAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.record.reject" },
    async () => {
      const user = await requireAdmin();
      const { recordId, reason } = parseFormOrThrow(rejectRecordSchema, formData);
      const rec = await loadRecord(recordId);
      if (rec.status === "committed" || rec.status === "skipped") {
        throw new ValidationError(
          `Record is ${rec.status} — cannot change decision.`,
        );
      }
      await db
        .update(importRecords)
        .set({
          status: "rejected",
          reviewerId: user.id,
          reviewedAt: new Date(),
          error: reason ?? null,
        })
        .where(eq(importRecords.id, recordId));

      await recalcBatchDecisionCounts(rec.batchId);

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RECORD_REJECTED,
        targetType: "d365_import_record",
        targetId: recordId,
        after: { status: "rejected", reason: reason ?? null },
      });

      revalidatePath(`/admin/d365-import/${rec.runId}/${rec.batchId}`);
    },
  );
}

export async function editRecordFieldsAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.record.edit_fields" },
    async () => {
      const user = await requireAdmin();
      const { recordId, mappedPayloadJson } = parseFormOrThrow(
        editRecordFieldsSchema,
        formData,
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(mappedPayloadJson);
      } catch {
        throw new ValidationError("Edited payload is not valid JSON.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ValidationError(
          "Edited payload must be a JSON object (not array, not primitive).",
        );
      }

      const rec = await loadRecord(recordId);
      if (rec.status === "committed" || rec.status === "skipped") {
        throw new ValidationError(
          `Record is ${rec.status} — cannot edit after commit.`,
        );
      }

      // The UI edits the unwrapped `mapped` object. Re-wrap into the
      // `{ mapped, attached, customFields }` shape that commit-batch
      // expects so `attached` activities and custom-field passthrough
      // survive the edit.
      const existingWrapper = (rec.mappedPayload ?? {}) as Record<string, unknown>;
      const existingAttached = Array.isArray(existingWrapper.attached)
        ? existingWrapper.attached
        : [];
      const existingCustom =
        existingWrapper.customFields &&
        typeof existingWrapper.customFields === "object"
          ? (existingWrapper.customFields as Record<string, unknown>)
          : {};
      // Reuse the `loadRecord` read for the audit `before` — the UI only
      // edits the unwrapped `mapped` object, so that is the
      // forensically meaningful prior state.
      const priorMapped =
        existingWrapper.mapped && typeof existingWrapper.mapped === "object"
          ? (existingWrapper.mapped as Record<string, unknown>)
          : {};
      const newMapped = parsed as Record<string, unknown>;
      const newWrapper = {
        mapped: newMapped,
        attached: existingAttached,
        customFields: existingCustom,
      };

      await db
        .update(importRecords)
        .set({ mappedPayload: newWrapper })
        .where(eq(importRecords.id, recordId));

      await writeAudit({
        actorId: user.id,
        action: AUDIT_EVENTS.D365_RECORD_EDIT_FIELDS,
        targetType: "d365_import_record",
        targetId: recordId,
        before: priorMapped,
        after: newMapped,
      });

      revalidatePath(`/admin/d365-import/${rec.runId}/${rec.batchId}`);
    },
  );
}

export async function setConflictResolutionAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.record.set_conflict_resolution" },
    async () => {
      const user = await requireAdmin();
      const { recordId, resolution } = parseFormOrThrow(
        setConflictResolutionSchema,
        formData,
      );
      const rec = await loadRecord(recordId);
      if (rec.status === "committed" || rec.status === "skipped") {
        throw new ValidationError(
          `Record is ${rec.status} — cannot change conflict resolution.`,
        );
      }
      const priorResolution = rec.conflictResolution;
      await db
        .update(importRecords)
        .set({ conflictResolution: resolution })
        .where(eq(importRecords.id, recordId));

      await writeAudit({
        actorId: user.id,
        action: AUDIT_EVENTS.D365_RECORD_SET_CONFLICT_RESOLUTION,
        targetType: "d365_import_record",
        targetId: recordId,
        before: { resolution: priorResolution },
        after: { resolution },
      });

      revalidatePath(`/admin/d365-import/${rec.runId}/${rec.batchId}`);
    },
  );
}

/* -------------------------------------------------------------------------- *
 * Batch commit *
 * -------------------------------------------------------------------------- */

export async function commitBatchAction(
  formData: FormData,
): Promise<ActionResult<{ committed: number; skipped: number; failed: number }>> {
  return withErrorBoundary(
    { action: "d365.import.batch.commit" },
    async () => {
      const user = await requireAdmin();
      const { batchId } = parseFormOrThrow(commitBatchSchema, formData);

      const [batch] = await db
        .select({
          id: importBatches.id,
          runId: importBatches.runId,
          status: importBatches.status,
        })
        .from(importBatches)
        .where(eq(importBatches.id, batchId))
        .limit(1);
      if (!batch) throw new NotFoundError("import batch");
      if (batch.status === "committed") {
        throw new ValidationError("Batch already committed.");
      }
      if (batch.status === "committing") {
        // F-05 follow-up: commit-batch sets this transient state at
        // the start of its loop. If a second click lands here the
        // first run is still in flight; bounce instead of attempting
        // a parallel commit. If the first run crashed mid-loop the
        // catch handler resets to `reviewing`, so reaching this gate
        // means a real in-flight run.
        throw new ValidationError(
          "Batch commit already in progress — wait for it to finish.",
        );
      }
      if (batch.status === "failed") {
        throw new ValidationError(
          "Batch is in failed state — re-review required before commit.",
        );
      }

      // Refuse to commit while undecided records exist. The UI button
      // is already gated on this, but we re-check server-side to close
      // the race-condition gap.
      const undecided = await db
        .select({ id: importRecords.id })
        .from(importRecords)
        .where(
          and(
            eq(importRecords.batchId, batchId),
            inArray(importRecords.status, ["pending", "mapped", "review"]),
          ),
        )
        .limit(1);
      if (undecided[0]) {
        throw new ValidationError(
          "All records must be approved or rejected before commit.",
        );
      }

      const out = await commitBatch(batchId, user.id);

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.BATCH_COMMITTED,
        targetType: "d365_import_batch",
        targetId: batchId,
        after: out,
      });

      revalidatePath(`/admin/d365-import/${batch.runId}`);
      revalidatePath(`/admin/d365-import/${batch.runId}/${batchId}`);
      return out;
    },
  );
}

/* -------------------------------------------------------------------------- *
 * Cross-root FK reconcile sweep *
 * -------------------------------------------------------------------------- */

/**
 * Re-resolve any cross-root FK left NULL at commit time for the records
 * one run committed (a root's cross-root parent — account/contact/lead —
 * landed in a later batch, so it couldn't resolve in the first pass).
 *
 * Replaces the manual opportunity-FK backfill: the same
 * quarantine-then-reconcile pattern, generalized to every cross-root
 * edge (opportunity→account/contact/originatingLead; contact→account;
 * account→parentAccount/primaryContact) and scoped to a single run.
 * Children never need this — they are pinned to the root's in-memory
 * UUID at commit time and cannot miss.
 *
 * Idempotent: only fills a column that is currently NULL, only when
 * resolution succeeds. Runs automatically when a run is marked complete;
 * this action lets an admin trigger it on demand.
 */
export async function reconcileRunFksAction(
  formData: FormData,
): Promise<
  ActionResult<{
    scanned: number;
    resolved: number;
    stillUnresolved: number;
    noSourceProvenance: number;
  }>
> {
  return withErrorBoundary(
    { action: "d365.import.run.reconcile_fks" },
    async () => {
      const user = await requireAdmin();
      const { runId } = parseFormOrThrow(pullNextBatchSchema, formData);
      const result = await reconcileRunFks(runId, user.id);
      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${runId}`);
      return result;
    },
  );
}
