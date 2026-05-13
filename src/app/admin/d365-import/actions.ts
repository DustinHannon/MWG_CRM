"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
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
import { D365_AUDIT_EVENTS } from "@/lib/d365/audit-events";
import {
  abortRunSchema,
  approveRecordSchema,
  commitBatchSchema,
  createRunSchema,
  editRecordFieldsSchema,
  formDataToObject,
  markCompleteSchema,
  pullNextBatchSchema,
  quickPullSchema,
  rejectRecordSchema,
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
 * Sub-agent A is shipping `pullNextBatch`, `mapBatch`, `resumeRun`
 * helpers; Sub-agent B is shipping `commitBatch`. Until those land
 * we either dynamically import them (so the build doesn't break) or
 * fall back to a minimal inline implementation that exercises the DB
 * + audit + revalidate paths the UI needs to be functional.
 */

/* -------------------------------------------------------------------------- *
 * Helpers *
 * -------------------------------------------------------------------------- */

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } },
  formData: FormData,
): T {
  const result = schema.safeParse(formDataToObject(formData));
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ValidationError(
      first
        ? `${first.path.join(".") || "input"}: ${first.message}`
        : "Validation failed.",
    );
  }
  return result.data;
}

/**
 * Build a default scope for a quick-pull. Per user instruction
 * (2026-05-10): NO filters — quick-pull walks the entire D365
 * history for that entity, ordered by modifiedon DESC. Includes
 * disqualified / lost / closed records (any statecode). The cursor
 * advances per click and the run terminates when D365 returns no
 * more pages.
 *
 * Use the "+ New import run" modal if you want to scope to a date
 * range or active-only.
 *
 * Note: `entityType` is intentionally unused at the moment — kept
 * in the signature so a future scope variant per entity (e.g. notes
 * vs leads needing different OData query shapes) drops in cleanly.
 */
function defaultQuickPullScope(_entityType: string): Record<string, unknown> {
  return {
    filter: {},
    includeChildren: false,
  };
}

/**
 * Optional dynamic import of Sub-agent A's queries module. Returns
 * null (not throws) when the module isn't on disk yet. The action
 * caller falls back to its inline minimum behavior.
 */
async function tryLoadPullBatch(): Promise<
  | ((runId: string, actorId: string) => Promise<{ batchId: string }>)
  | null
> {
  try {
    const mod = (await import("@/lib/d365/pull-batch")) as {
      pullNextBatch?: (
        runId: string,
        actorId: string,
      ) => Promise<{ batchId: string }>;
    };
    return mod.pullNextBatch ?? null;
  } catch {
    return null;
  }
}

async function tryLoadMapBatch(): Promise<
  | ((batchId: string, actorId: string) => Promise<void>)
  | null
> {
  try {
    const mod = (await import("@/lib/d365/map-batch")) as unknown as {
      mapBatch?: (batchId: string, actorId: string) => Promise<void>;
    };
    return mod.mapBatch ?? null;
  } catch {
    return null;
  }
}

async function tryLoadCommitBatch(): Promise<
  | ((batchId: string, actorId: string) => Promise<{
      committed: number;
      skipped: number;
      failed: number;
    }>)
  | null
> {
  try {
    const mod = (await import("@/lib/d365/commit-batch")) as {
      commitBatch?: (
        batchId: string,
        actorId: string,
      ) => Promise<{
        committed: number;
        skipped: number;
        failed: number;
      }>;
    };
    return mod.commitBatch ?? null;
  } catch {
    return null;
  }
}

/**
 * Sub-agent A's `resumeRun(runId, resolution, actorId)` takes a
 * `ResumeResolution` discriminated union. We translate the form-data
 * shape (`reason` + optional `conflictResolution`) into that union
 * here so the action contract stays form-friendly.
 */
type ResumeResolutionKind =
  | { kind: "retry" }
  | { kind: "fix_picklist" }
  | { kind: "use_default_owner" }
  | { kind: "open_for_review" }
  | {
      kind: "apply_dedup_default";
      defaultBehavior: "skip" | "overwrite" | "merge";
    };

async function tryLoadResumeRun(): Promise<
  | ((runId: string, resolution: ResumeResolutionKind, actorId: string) => Promise<void>)
  | null
> {
  try {
    const mod = (await import("@/lib/d365/resume-run")) as unknown as {
      resumeRun?: (
        runId: string,
        resolution: ResumeResolutionKind,
        actorId: string,
      ) => Promise<void>;
    };
    return mod.resumeRun ?? null;
  } catch {
    return null;
  }
}

function mapResumeFormToResolution(
  reason: string,
  conflictResolution: string | undefined,
): ResumeResolutionKind {
  switch (reason) {
    case "d365_unreachable":
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
    default:
      return { kind: "open_for_review" };
  }
}

/* -------------------------------------------------------------------------- *
 * Run actions *
 * -------------------------------------------------------------------------- */

export async function createRunAction(
  formData: FormData,
): Promise<ActionResult<{ runId: string }>> {
  return withErrorBoundary(
    { action: "d365.import.run.create" },
    async () => {
      const user = await requireAdmin();
      const input = parse(createRunSchema, formData);

      const supportsActiveOnly =
        input.entityType === "lead" ||
        input.entityType === "contact" ||
        input.entityType === "account" ||
        input.entityType === "opportunity";

      const modifiedSinceIso = input.modifiedSince
        ? `${input.modifiedSince}T00:00:00.000Z`
        : (() => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 2);
            return d.toISOString();
          })();

      const scope: Record<string, unknown> = {
        filter: {
          modifiedSince: modifiedSinceIso,
          ...(supportsActiveOnly && input.activeOnly ? { statecode: [0] } : {}),
        },
        includeChildren: !!input.includeChildren,
      };

      const [row] = await db
        .insert(importRuns)
        .values({
          source: "d365",
          entityType: input.entityType,
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
        targetType: "d365_import_run",
        targetId: row.id,
        after: { entityType: input.entityType, scope },
      });

      revalidatePath("/admin/d365-import");
      return { runId: row.id };
    },
  );
}

/**
 * Quick-pull: one of nine entity buttons. Reuses an existing open run
 * for that entity if present; otherwise creates one with default scope.
 * Then chains pullNextBatch + mapBatch.
 */
export async function quickPullAction(
  formData: FormData,
): Promise<ActionResult<{ runId: string; batchId: string | null }>> {
  return withErrorBoundary(
    { action: "d365.import.run.quick_pull" },
    async () => {
      const user = await requireAdmin();
      const input = parse(quickPullSchema, formData);

      // Find a reusable run for this admin + entity type. Acceptable
      // statuses: created, fetching, mapping, reviewing. paused_for_review
      // requires explicit Resume; completed/aborted are terminal.
      const existing = await db
        .select({ id: importRuns.id, status: importRuns.status })
        .from(importRuns)
        .where(
          and(
            eq(importRuns.createdById, user.id),
            eq(importRuns.entityType, input.entityType),
            inArray(importRuns.status, [
              "created",
              "fetching",
              "mapping",
              "reviewing",
            ]),
          ),
        )
        .orderBy(desc(importRuns.createdAt))
        .limit(1);

      let runId: string;
      if (existing[0]) {
        runId = existing[0].id;
      } else {
        const [row] = await db
          .insert(importRuns)
          .values({
            source: "d365",
            entityType: input.entityType,
            status: "created",
            scope: defaultQuickPullScope(input.entityType),
            createdById: user.id,
          })
          .returning({ id: importRuns.id });
        if (!row) throw new ConflictError("Could not create run.");
        runId = row.id;
        await writeAudit({
          actorId: user.id,
          action: D365_AUDIT_EVENTS.RUN_CREATED,
          targetType: "d365_import_run",
          targetId: runId,
          after: { entityType: input.entityType, viaQuickPull: true },
        });
      }

      // Chain pull + map (best-effort — Sub-agent A/B may not be
      // shipped yet; in that case we still return runId so the user
      // lands on the run-detail page and sees the stub messaging).
      const pull = await tryLoadPullBatch();
      const map = await tryLoadMapBatch();

      let batchId: string | null = null;
      if (pull) {
        try {
          const out = await pull(runId, user.id);
          batchId = out.batchId;
          if (map) {
            await map(batchId, user.id);
          }
        } catch (err) {
          logger.warn("d365.quick_pull.pull_or_map_failed", {
            runId,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${runId}`);
      return { runId, batchId };
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
      const { runId } = parse(pullNextBatchSchema, formData);

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

      const pull = await tryLoadPullBatch();
      if (!pull) {
        throw new ValidationError(
          "Pull pipeline not yet available (sub-agent A pending).",
        );
      }

      let batchId: string | null = null;
      try {
        const out = await pull(runId, user.id);
        batchId = out.batchId;
      } catch (err) {
        logger.error("d365.pull_batch.failed", {
          runId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const map = await tryLoadMapBatch();
      if (map && batchId) {
        try {
          await map(batchId, user.id);
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
      const { runId } = parse(abortRunSchema, formData);

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
        targetType: "d365_import_run",
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
      const { runId } = parse(markCompleteSchema, formData);

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

      // Refuse if any batch is still pending/reviewing.
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
            ]),
          ),
        )
        .limit(1);
      if (blockers[0]) {
        throw new ValidationError(
          "Cannot mark complete while batches are still pending or under review.",
        );
      }

      await db
        .update(importRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(importRuns.id, runId));

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RUN_COMPLETED,
        targetType: "d365_import_run",
        targetId: runId,
        before: { status: run.status },
        after: { status: "completed" },
      });

      revalidatePath("/admin/d365-import");
      revalidatePath(`/admin/d365-import/${runId}`);
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
      const input = parse(resumeRunSchema, formData);

      const [run] = await db
        .select({
          id: importRuns.id,
          status: importRuns.status,
          notes: importRuns.notes,
        })
        .from(importRuns)
        .where(eq(importRuns.id, input.runId))
        .limit(1);
      if (!run) throw new NotFoundError("import run");
      if (run.status !== "paused_for_review") {
        throw new ValidationError(`Run is ${run.status} — nothing to resume.`);
      }

      const resumeFn = await tryLoadResumeRun();
      const resolution = mapResumeFormToResolution(
        input.reason,
        input.conflictResolution,
      );
      if (resumeFn) {
        await resumeFn(input.runId, resolution, user.id);
      } else {
        // Inline minimum: persist resolution to notes, transition to
        // 'reviewing' so the next pullNextBatch can fire, audit.
        const noteLine = JSON.stringify({
          at: new Date().toISOString(),
          kind: "resumed",
          reason: input.reason,
          resolution: input.conflictResolution ?? null,
          actorId: user.id,
        });
        const nextNotes = run.notes ? `${run.notes}\n${noteLine}` : noteLine;
        await db
          .update(importRuns)
          .set({ status: "reviewing", notes: nextNotes })
          .where(eq(importRuns.id, input.runId));
      }

      await writeAudit({
        actorId: user.id,
        action: D365_AUDIT_EVENTS.RUN_RESUMED,
        targetType: "d365_import_run",
        targetId: input.runId,
        before: { status: "paused_for_review", reason: input.reason },
        after: {
          status: "reviewing",
          resolution: input.conflictResolution ?? null,
        },
      });

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
}> {
  const rows = await db
    .select({
      id: importRecords.id,
      batchId: importRecords.batchId,
      status: importRecords.status,
      runId: importBatches.runId,
      mappedPayload: importRecords.mappedPayload,
    })
    .from(importRecords)
    .innerJoin(importBatches, eq(importBatches.id, importRecords.batchId))
    .where(eq(importRecords.id, recordId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("import record");
  return row;
}

export async function approveRecordAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "d365.import.record.approve" },
    async () => {
      const user = await requireAdmin();
      const { recordId } = parse(approveRecordSchema, formData);
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
      const { recordId, reason } = parse(rejectRecordSchema, formData);
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
      const { recordId, mappedPayloadJson } = parse(
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
      const newWrapper = {
        mapped: parsed as Record<string, unknown>,
        attached: existingAttached,
        customFields: existingCustom,
      };

      await db
        .update(importRecords)
        .set({ mappedPayload: newWrapper })
        .where(eq(importRecords.id, recordId));

      // No dedicated audit event — bundles into approve/commit history.
      logger.info("d365.import.record.edited", {
        recordId,
        actorId: user.id,
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
      const { recordId, resolution } = parse(
        setConflictResolutionSchema,
        formData,
      );
      const rec = await loadRecord(recordId);
      if (rec.status === "committed" || rec.status === "skipped") {
        throw new ValidationError(
          `Record is ${rec.status} — cannot change conflict resolution.`,
        );
      }
      await db
        .update(importRecords)
        .set({ conflictResolution: resolution })
        .where(eq(importRecords.id, recordId));

      logger.info("d365.import.record.conflict_resolution_set", {
        recordId,
        actorId: user.id,
        resolution,
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
      const { batchId } = parse(commitBatchSchema, formData);

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

      const commitFn = await tryLoadCommitBatch();
      if (!commitFn) {
        throw new ValidationError(
          "Commit pipeline not yet available (sub-agent B pending).",
        );
      }

      const out = await commitFn(batchId, user.id);

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
