import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  ConflictError,
  KnownError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { D365_AUDIT_EVENTS, D365_HALT_REASONS } from "./audit-events";
import { D365HttpError } from "./with-retry";
import { getD365Client } from "./client";
import {
  fetchByEntityType,
  type BaseFetchOpts,
  type FetchPageResult,
} from "./queries";
import { broadcastRunEvent } from "./realtime-broadcast";
import {
  D365_ENTITY_TYPES,
  type D365EntityType,
  D365_ENTITY_PK,
} from "./types";

/**
 * orchestrator that pulls one batch (≤100 records) of an
 * import run from D365 and persists it for human review.
 *
 * Flow:
 *
 * 1. Acquire transaction-scoped advisory lock on the run id so a
 * double-clicked "Pull next batch" can't double-pull.
 * 2. Load the run; assert status ∈ {created, fetching, reviewing}
 * and entityType is one of the nine supported.
 * 3. Reserve the next `import_batches` row (status='pending') with
 * monotonic `batch_number` per run.
 * 4. Broadcast `fetching.started` → call entity-specific query
 * builder → broadcast `fetching.progress` → on success persist
 * `import_records` rows + update batch + update run cursor.
 * 5. On retry exhaustion (`D365HttpError` thrown after retries):
 * transition run to `paused_for_review`, append note, emit
 * `RUN_HALTED`, broadcast `halted`, throw a typed error for the
 * caller.
 *
 * Returns `{ batchId, recordCount, nextCursor }`. `nextCursor` is the
 * server-supplied OData @odata.nextLink for the *next* page, or null
 * when this was the final page (run can transition to `mapping`).
 *
 * Concurrency: pg_advisory_xact_lock is held for the duration of the
 * transaction we open around the lock acquisition. The transaction
 * commits after we've reserved the batch row — the actual D365 fetch
 * happens OUTSIDE the lock so a slow Dynamics call doesn't block a
 * concurrent admin from operating on a different run. A second
 * worker for the SAME run will block on the lock until the first
 * commits its reservation, then will see the new cursor and pull the
 * next page (idempotent by design).
 */

export interface PullBatchResult {
  batchId: string;
  batchNumber: number;
  recordCount: number;
  nextCursor: string | null;
  /** True when the underlying query reports no further pages. */
  isFinalPage: boolean;
}

interface RunRow {
  id: string;
  status: typeof importRuns.$inferSelect.status;
  entityType: string;
  scope: unknown;
  cursor: string | null;
  notes: string | null;
}

const ALLOWED_PULL_STATUSES = new Set<RunRow["status"]>([
  "created",
  "fetching",
  "reviewing",
]);

const ENTITY_TYPE_SET = new Set<string>(D365_ENTITY_TYPES);

interface RunScope {
  filter?: {
    modifiedSince?: string;
    statecode?: number[];
    ids?: string[];
  };
  fields?: string[];
  expand?: boolean | string[];
  includeChildren?: boolean;
}

/**
 * Pull and persist the next batch for a run. Caller is responsible
 * for `withErrorBoundary` wrapping (this is a lib helper — it throws
 * KnownError subclasses on app-domain failures).
 */
export async function pullNextBatch(
  runId: string,
  actorId: string,
): Promise<PullBatchResult> {
  if (!runId) throw new ValidationError("runId is required.");
  if (!actorId) throw new ValidationError("actorId is required.");

  // reserve a batch row under advisory lock + return cursor.
  const reservation = await reserveNextBatch(runId);
  const { batchId, batchNumber, run } = reservation;

  const entityType = run.entityType as D365EntityType;

  await broadcastRunEvent(runId, "fetching.started", {
    batchId,
    batchNumber,
    entityType,
  });

  // fetch from D365 OUTSIDE the lock.
  const fetchOpts = scopeToFetchOpts(run.scope, run.cursor);
  let fetched: FetchPageResult<unknown>;
  try {
    fetched = await fetchByEntityType(getD365Client(), entityType, fetchOpts);
  } catch (err) {
    await handleFetchFailure(runId, batchId, actorId, entityType, err);
    // handleFetchFailure throws — this is unreachable but keeps
    // typescript flow analysis honest.
    throw err;
  }

  const records = fetched.records;
  const nextLink = fetched.nextLink ?? null;
  const isFinalPage = !nextLink;

  await broadcastRunEvent(runId, "fetching.progress", {
    batchId,
    batchNumber,
    fetched: records.length,
    nextLinkPresent: Boolean(nextLink),
  });

  // persist records + update run cursor + batch row.
  const pkColumn = D365_ENTITY_PK[entityType];
  await db.transaction(async (tx) => {
    if (records.length > 0) {
      await tx.insert(importRecords).values(
        records.map((raw) => {
          const obj = (raw ?? {}) as Record<string, unknown>;
          // Recency preservation rule: rawPayload is stored verbatim;
          // mappers handle createdAt/updatedAt at commit time. We do
          // NOT mutate or strip timestamps here.
          const sourceId = String(obj[pkColumn] ?? "");
          if (!sourceId) {
            // Defensive — we've selected the PK column explicitly so
            // this should never fire. Log + carry on with empty
            // string so the row still persists and the reviewer can
            // raise it manually.
            logger.error("d365.pull.missing_source_id", {
              runId,
              batchId,
              entityType,
              pkColumn,
            });
          }
          return {
            batchId,
            sourceEntityType: entityType,
            sourceId,
            rawPayload: obj,
            status: "pending" as const,
          };
        }),
      );
    }

    await tx
      .update(importBatches)
      .set({
        status: "fetched",
        fetchedAt: sql`now()`,
        recordCountFetched: records.length,
      })
      .where(eq(importBatches.id, batchId));

    await tx
      .update(importRuns)
      .set({
        cursor: nextLink,
        status: isFinalPage ? "mapping" : "fetching",
      })
      .where(eq(importRuns.id, runId));
  });

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.BATCH_FETCHED,
    targetType: "import_batch",
    targetId: batchId,
    after: {
      runId,
      entityType,
      batchNumber,
      recordCount: records.length,
      cursorAdvanced: Boolean(nextLink),
      isFinalPage,
    },
  });

  await broadcastRunEvent(runId, "fetching.completed", {
    batchId,
    batchNumber,
    recordCount: records.length,
    isFinalPage,
  });

  logger.info("d365.pull_batch.completed", {
    runId,
    batchId,
    batchNumber,
    entityType,
    recordCount: records.length,
    isFinalPage,
  });

  return {
    batchId,
    batchNumber,
    recordCount: records.length,
    nextCursor: nextLink,
    isFinalPage,
  };
}

/* -------------------------------------------------------------------------- *
 * Reservation under lock *
 * -------------------------------------------------------------------------- */

async function reserveNextBatch(runId: string): Promise<{
  batchId: string;
  batchNumber: number;
  run: RunRow;
}> {
  return db.transaction(async (tx) => {
    // Transaction-scoped advisory lock per run id. `hashtext` -> int4
    // and the namespaced prefix avoids collisions with other features.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`d365.run.${runId}`}))`,
    );

    const [run] = await tx
      .select({
        id: importRuns.id,
        status: importRuns.status,
        entityType: importRuns.entityType,
        scope: importRuns.scope,
        cursor: importRuns.cursor,
        notes: importRuns.notes,
      })
      .from(importRuns)
      .where(eq(importRuns.id, runId))
      .limit(1);

    if (!run) throw new NotFoundError("import run");

    if (!ALLOWED_PULL_STATUSES.has(run.status)) {
      throw new ConflictError(
        `Run is in status '${run.status}' and cannot accept a new batch.`,
        { status: run.status },
      );
    }

    if (!ENTITY_TYPE_SET.has(run.entityType)) {
      throw new ValidationError(
        `Unsupported D365 entity type '${run.entityType}'.`,
      );
    }

    // Compute next batch_number: max(batch_number) + 1 within run, or 1.
    const [{ next }] = await tx.execute<{ next: number }>(
      sql`select coalesce(max(batch_number), 0) + 1 as next from import_batches where run_id = ${runId}`,
    );
    const batchNumber = Number(next);

    const [inserted] = await tx
      .insert(importBatches)
      .values({
        runId,
        batchNumber,
        status: "pending",
        recordCountFetched: 0,
      })
      .returning({ id: importBatches.id });

    if (!inserted)
      throw new Error("invariant: failed to insert import_batches row");

    // Move the run to 'fetching' once any batch reservation succeeds
    // so concurrent UI reflects in-progress state immediately.
    if (run.status === "created" || run.status === "reviewing") {
      await tx
        .update(importRuns)
        .set({ status: "fetching" })
        .where(eq(importRuns.id, runId));
    }

    return { batchId: inserted.id, batchNumber, run };
  });
}

/* -------------------------------------------------------------------------- *
 * Scope -> fetch opts *
 * -------------------------------------------------------------------------- */

function scopeToFetchOpts(
  scopeJson: unknown,
  cursor: string | null,
): BaseFetchOpts {
  const scope = (scopeJson ?? {}) as RunScope;
  const opts: BaseFetchOpts = {
    top: 100,
    expand:
      typeof scope.includeChildren === "boolean"
        ? scope.includeChildren
        : Array.isArray(scope.expand)
          ? scope.expand.length > 0
          : Boolean(scope.expand),
  };
  if (cursor) {
    opts.nextLink = cursor;
    return opts;
  }
  if (scope.filter?.modifiedSince) {
    const d = new Date(scope.filter.modifiedSince);
    if (!Number.isNaN(d.getTime())) opts.modifiedSince = d;
  }
  if (scope.filter?.ids?.length) {
    opts.ids = scope.filter.ids;
  }
  return opts;
}

/* -------------------------------------------------------------------------- *
 * D365_UNREACHABLE halt path *
 * -------------------------------------------------------------------------- */

async function handleFetchFailure(
  runId: string,
  batchId: string,
  actorId: string,
  entityType: D365EntityType,
  err: unknown,
): Promise<never> {
  // Only D365HttpError after retry exhaustion is treated as the H-1
  // halt; anything else (programmer error, abort) bubbles as an
  // internal error. The retry wrapper has already exhausted backoffs
  // before throwing.
  const isHttp = err instanceof D365HttpError;
  const isUnreachable =
    isHttp ||
    (err instanceof Error &&
      (err.name === "AbortError" ||
        /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(err.message)));

  if (!isUnreachable) {
    // Unknown failure: leave the batch in 'pending' (manual retry) and
    // re-throw so the caller's error boundary surfaces it.
    logger.error("d365.pull.unexpected_error", {
      runId,
      batchId,
      entityType,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // explicit audit event so the forensic trail
    // captures non-halt fetch failures alongside the logger output.
    await writeAudit({
      actorId,
      action: D365_AUDIT_EVENTS.FETCH_FAILED,
      targetType: "import_batch",
      targetId: batchId,
      after: {
        runId,
        entityType,
        errorMessage:
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        kind: "unexpected_error",
      },
    });
    throw err;
  }

  const haltReason = D365_HALT_REASONS.D365_UNREACHABLE;
  // Note shape MUST match the contract read by the run-detail page's
  // parseHaltFromNotes (`kind: "halt"` + `reason: <D365HaltReason>` +
  // optional `message`). Don't change without updating both sides.
  const errorMessage = err instanceof Error ? err.message : String(err);
  const detail = {
    kind: "halt" as const,
    reason: haltReason,
    status: isHttp ? err.status : undefined,
    message: errorMessage,
    errorMessage,
    ts: new Date().toISOString(),
  };

  // Append the halt entry to the JSON-line notes stream. We do the
  // string concat in SQL so we don't need to round-trip the existing
  // notes value to the app server.
  const noteLine = `${JSON.stringify(detail)}\n`;
  await db.transaction(async (tx) => {
    await tx
      .update(importBatches)
      .set({ status: "failed" })
      .where(eq(importBatches.id, batchId));

    await tx
      .update(importRuns)
      .set({
        status: "paused_for_review",
        notes: sql`coalesce(${importRuns.notes}, '') || ${noteLine}`,
      })
      .where(eq(importRuns.id, runId));
  });

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.RUN_HALTED,
    targetType: "import_run",
    targetId: runId,
    after: { reason: haltReason, batchId, entityType, detail },
  });

  await broadcastRunEvent(runId, "halted", {
    batchId,
    entityType,
    reason: haltReason,
    detail,
  });

  logger.warn("d365.pull.halted_d365_unreachable", {
    runId,
    batchId,
    entityType,
    status: isHttp ? err.status : undefined,
  });

  throw new D365UnreachableError(
    "Dynamics 365 is unreachable after retries; run paused for review.",
    { runId, batchId, status: isHttp ? err.status : undefined },
  );
}

/* -------------------------------------------------------------------------- *
 * Errors *
 * -------------------------------------------------------------------------- */

/**
 * Thrown when the orchestrator transitions a run to
 * `paused_for_review` because Dynamics 365 was unreachable. Caller's
 * server-action `withErrorBoundary` translates this into a CONFLICT-
 * coded ActionResult so the UI can surface a "Resume" CTA.
 */
export class D365UnreachableError extends KnownError {
  constructor(publicMessage: string, meta?: Record<string, unknown>) {
    super("CONFLICT", publicMessage, "d365_unreachable", meta);
    this.name = "D365UnreachableError";
  }
}
