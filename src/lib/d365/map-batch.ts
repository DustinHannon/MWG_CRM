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
  D365_AUDIT_EVENTS,
  D365_HALT_REASONS,
  D365_REALTIME_EVENTS,
  type D365RealtimeEvent,
} from "./audit-events";
import { broadcastRunEvent } from "./realtime-broadcast";
import {
  dedupAccount,
  dedupActivity,
  dedupContact,
  dedupLead,
  dedupOpportunity,
  type ConflictResolution,
  type DedupResult,
} from "./dedup";
import {
  getMapperForEntity,
  MappingError,
  type MapResult,
  type ValidationWarning,
} from "./mapping";
import { resolveD365Owner } from "./owner-mapping";
import { shouldHaltOnGarbageVolume } from "./quality";
import type {
  D365Account,
  D365Annotation,
  D365Appointment,
  D365Contact,
  D365Email,
  D365EntityType,
  D365Lead,
  D365Opportunity,
  D365PhoneCall,
  D365Task,
} from "./types";

/**
 * Phase 23 — `mapBatch` orchestrator.
 *
 * Loads pending `import_records` for a batch, runs the right mapper,
 * then dedup, then persists the mappedPayload + warnings + conflict
 * resolution. Halts the run if any mapper reports an unmapped
 * picklist (per brief — humans must review these before commit).
 *
 * Realtime broadcast is delegated to `broadcastD365Event` (kept
 * lightweight here — Sub-agent A wires the actual Supabase channel
 * publish in `broadcast.ts`; this stub logs).
 */

export interface MapBatchResult {
  recordCount: number;
  conflictCount: number;
  warningCount: number;
}

/**
 * Resolve a D365 owner GUID + cached email lookup → mwg-crm user id.
 * Sub-agent A's pull-batch flow attaches the resolved email to the
 * stored raw payload (see types `_ownerid_value_email` synthetic key).
 * If absent, the resolver falls back to the default owner.
 */
function getOwnerEmailFromRaw(
  raw: Record<string, unknown>,
): string | null | undefined {
  // Sub-agent A's pull stores the resolved email under a synthetic
  // `_ownerid_value_email` key (or `_ownerid_value@OData.Community.Display.V1.FormattedValue`
  // depending on how the owninguser expand was issued).
  const direct = raw["_ownerid_value_email"];
  if (typeof direct === "string") return direct;
  const formatted =
    raw["_ownerid_value@OData.Community.Display.V1.FormattedValue"];
  if (typeof formatted === "string") return formatted;
  return null;
}

/**
 * Thin wrapper over Sub-agent A's `broadcastRunEvent`. Centralises
 * the typed event-name lookup so map-batch never references string
 * literals (every event flows through `D365_REALTIME_EVENTS`).
 */
async function broadcastD365Event(args: {
  runId: string;
  event: D365RealtimeEvent;
  payload: Record<string, unknown>;
}): Promise<void> {
  await broadcastRunEvent(args.runId, args.event, args.payload);
}

/**
 * Halt the run with a reason. Inline implementation here — Sub-agent
 * A may extract a reusable `haltRun(...)` helper later.
 */
async function haltRun(args: {
  runId: string;
  actorId: string;
  reason: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  // JSON-line note shape MUST match the contract read by Sub-agent C's
  // parseHaltFromNotes (`kind: "halt"` + `reason: <D365HaltReason>`).
  const noteEntry = {
    kind: "halt" as const,
    reason: args.reason,
    ...args.detail,
    ts: new Date().toISOString(),
  };
  const noteLine = `${JSON.stringify(noteEntry)}\n`;

  await db
    .update(importRuns)
    .set({
      status: "paused_for_review",
      notes: sql`coalesce(${importRuns.notes}, '') || ${noteLine}`,
    })
    .where(eq(importRuns.id, args.runId));

  await writeAudit({
    actorId: args.actorId,
    action: D365_AUDIT_EVENTS.RUN_HALTED,
    targetType: "import_run",
    targetId: args.runId,
    after: { reason: args.reason, ...args.detail },
  });

  await broadcastD365Event({
    runId: args.runId,
    event: D365_REALTIME_EVENTS.HALTED,
    payload: { reason: args.reason, ...args.detail },
  });
}

/* -------------------------------------------------------------------------- *
 *                              Dispatcher                                    *
 * -------------------------------------------------------------------------- */

async function dispatchMap(
  entityType: D365EntityType,
  raw: Record<string, unknown>,
  ctx: { resolvedOwnerId: string; resolvedUserId: string | null },
): Promise<MapResult<unknown>> {
  const mapper = getMapperForEntity(entityType);
  switch (entityType) {
    case "lead":
      return mapper(raw as unknown as D365Lead, {
        resolvedOwnerId: ctx.resolvedOwnerId,
      }) as MapResult<unknown>;
    case "contact":
      return mapper(raw as unknown as D365Contact, {
        resolvedOwnerId: ctx.resolvedOwnerId,
      }) as MapResult<unknown>;
    case "account":
      return mapper(raw as unknown as D365Account, {
        resolvedOwnerId: ctx.resolvedOwnerId,
      }) as MapResult<unknown>;
    case "opportunity":
      return mapper(raw as unknown as D365Opportunity, {
        resolvedOwnerId: ctx.resolvedOwnerId,
      }) as MapResult<unknown>;
    case "annotation":
      return mapper(raw as unknown as D365Annotation, {
        resolvedUserId: ctx.resolvedUserId,
      }) as MapResult<unknown>;
    case "task":
      return mapper(raw as unknown as D365Task, {
        resolvedAssignedToId: ctx.resolvedUserId,
        resolvedCreatedById: ctx.resolvedUserId,
      }) as MapResult<unknown>;
    case "phonecall":
      return mapper(raw as unknown as D365PhoneCall, {
        resolvedUserId: ctx.resolvedUserId,
      }) as MapResult<unknown>;
    case "appointment":
      return mapper(raw as unknown as D365Appointment, {
        resolvedUserId: ctx.resolvedUserId,
      }) as MapResult<unknown>;
    case "email":
      return mapper(raw as unknown as D365Email, {
        resolvedUserId: ctx.resolvedUserId,
      }) as MapResult<unknown>;
    default: {
      const _exhaustive: never = entityType;
      void _exhaustive;
      throw new Error(`Unknown entity type in dispatchMap: ${entityType}`);
    }
  }
}

async function dispatchDedup(
  entityType: D365EntityType,
  mapped: unknown,
  externalId: string,
): Promise<DedupResult> {
  switch (entityType) {
    case "lead":
      return dedupLead(mapped as Parameters<typeof dedupLead>[0], externalId);
    case "contact":
      return dedupContact(
        mapped as Parameters<typeof dedupContact>[0],
        externalId,
      );
    case "account":
      return dedupAccount(
        mapped as Parameters<typeof dedupAccount>[0],
        externalId,
      );
    case "opportunity":
      return dedupOpportunity(
        mapped as Parameters<typeof dedupOpportunity>[0],
        externalId,
      );
    case "annotation":
    case "task":
    case "phonecall":
    case "appointment":
    case "email":
      return dedupActivity(entityType, externalId);
    default: {
      const _exhaustive: never = entityType;
      void _exhaustive;
      throw new Error(`Unknown entity type in dispatchDedup: ${entityType}`);
    }
  }
}

/* -------------------------------------------------------------------------- *
 *                               mapBatch                                     *
 * -------------------------------------------------------------------------- */

export async function mapBatch(
  batchId: string,
  actorId: string,
): Promise<MapBatchResult> {
  // Look up the parent run for halt path + audit context.
  const batchRows = await db
    .select({ runId: importBatches.runId })
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  const runId = batchRows[0]?.runId;
  if (!runId) {
    throw new Error(`mapBatch: batch ${batchId} not found`);
  }

  // Pull pending records — process as a single page (batch size is
  // already capped at 100 by D365_IMPORT_BATCH_SIZE).
  const pending = await db
    .select({
      id: importRecords.id,
      sourceEntityType: importRecords.sourceEntityType,
      sourceId: importRecords.sourceId,
      rawPayload: importRecords.rawPayload,
    })
    .from(importRecords)
    .where(
      and(
        eq(importRecords.batchId, batchId),
        eq(importRecords.status, "pending"),
      ),
    );

  await broadcastD365Event({
    runId,
    event: D365_REALTIME_EVENTS.MAPPING_STARTED,
    payload: { batchId, recordCount: pending.length },
  });

  let conflictCount = 0;
  let warningCount = 0;
  let processed = 0;
  let halted = false;
  // Phase 23 — garbage-quality records auto-skip via the
  // `_qualityVerdict` virtual on the mapped payload. If > 50% of a
  // batch verdicts as garbage we halt the run for human review.
  let garbageCount = 0;
  // Don't halt on the first few records — need a meaningful sample
  // size before the ratio is informative.
  const HALT_MIN_SAMPLE = 10;

  for (const rec of pending) {
    if (halted) break;

    const entityType = rec.sourceEntityType as D365EntityType;
    const raw = (rec.rawPayload ?? {}) as Record<string, unknown>;

    let warnings: ValidationWarning[] = [];
    let mappedPayload: unknown = null;
    let dedup: DedupResult = {
      conflictWith: null,
      conflictResolution: "none",
      matchedBy: null,
    };
    let nextStatus: "mapped" | "review" | "failed" | "skipped" = "mapped";
    let errorText: string | null = null;

    try {
      // Resolve owner. Activities ride on resolvedUserId; entity
      // mappers consume resolvedOwnerId. Both come from the same
      // mwg-crm user — passing different keys keeps the mapper
      // signature intent clear.
      const ownerEmail = getOwnerEmailFromRaw(raw);
      const owner = await resolveD365Owner(ownerEmail, actorId);

      const result = await dispatchMap(entityType, raw, {
        resolvedOwnerId: owner.userId,
        resolvedUserId: owner.userId,
      });
      warnings = result.warnings;
      mappedPayload = {
        mapped: result.mapped,
        attached: result.attached,
        customFields: result.customFields,
      };

      dedup = await dispatchDedup(
        entityType,
        result.mapped,
        rec.sourceId,
      );

      if (dedup.conflictWith) {
        conflictCount += 1;
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_FLAGGED_CONFLICT,
          targetType: "import_record",
          targetId: rec.id,
          after: {
            conflictWith: dedup.conflictWith,
            matchedBy: dedup.matchedBy,
            entityType,
          },
        });
      }

      if (warnings.length > 0) {
        nextStatus = "review";
        warningCount += warnings.length;
      }

      // Phase 23 — bad-lead quality auto-skip. The lead mapper writes
      // `_qualityVerdict` + `_qualityReasons` virtuals onto the mapped
      // object. `garbage` short-circuits to skipped + audit; the
      // commit-batch cleanPayload step strips `_*` virtuals before
      // Drizzle insert so they never reach the database.
      const qualityVerdict = (result.mapped as Record<string, unknown>)
        ._qualityVerdict;
      if (qualityVerdict === "garbage") {
        const reasons =
          ((result.mapped as Record<string, unknown>)._qualityReasons as
            | string[]
            | undefined) ?? [];
        garbageCount += 1;
        nextStatus = "failed"; // overwritten below to 'skipped'
        // Use status 'skipped' (a valid import_records status) so the
        // record can be reviewed and un-skipped manually if needed.
        nextStatus = "skipped";
        errorText = `Auto-skipped (bad_lead_quality): ${reasons.join("; ")}`;
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_SKIPPED,
          targetType: "import_record",
          targetId: rec.id,
          after: {
            reason: "bad_lead_quality",
            qualityReasons: reasons,
            entityType,
            sourceId: rec.sourceId,
          },
        });
        logger.info("d365.map_batch.auto_skip_garbage", {
          recordId: rec.id,
          sourceId: rec.sourceId,
          entityType,
          reasons,
        });
      }

      // Halt-on-unmapped-picklist gate (brief §"Constraints" + §4.5).
      // Skip the gate for records that already auto-skipped on quality —
      // bad-quality records frequently carry weird picklist values that
      // shouldn't drive a system-wide halt. The picklist halt must only
      // fire on records we'd otherwise commit.
      const hasUnmappedPicklist =
        nextStatus !== "skipped" &&
        warnings.some((w) => w.code === "unmapped_picklist");
      if (hasUnmappedPicklist) {
        await haltRun({
          runId,
          actorId,
          reason: D365_HALT_REASONS.UNMAPPED_PICKLIST,
          detail: {
            recordId: rec.id,
            entityType,
            unmappedFields: warnings
              .filter((w) => w.code === "unmapped_picklist")
              .map((w) => w.field),
          },
        });
        halted = true;
        // Still persist this record's mapped payload so reviewer sees it.
      }
    } catch (err) {
      if (err instanceof MappingError) {
        nextStatus = "failed";
        errorText = err.message;
        // Log so the server-side trace captures mapping validation
        // failures (otherwise a flood of bad records leaves no
        // operator-visible signal).
        logger.info("d365.map_batch.mapping_error", {
          batchId,
          recordId: rec.id,
          sourceId: rec.sourceId,
          entityType,
          errorMessage: errorText,
        });
      } else {
        nextStatus = "failed";
        errorText = err instanceof Error ? err.message : String(err);
        logger.error("d365.map_batch.unexpected_error", {
          batchId,
          recordId: rec.id,
          errorMessage: errorText,
        });
      }
    }

    // Persist record state. JSONB inserts via Drizzle take plain JS
    // objects; the driver serialises.
    await db
      .update(importRecords)
      .set({
        mappedPayload: (mappedPayload as object | null) ?? null,
        validationWarnings: (warnings as unknown as object) ?? null,
        conflictWith: dedup.conflictWith,
        conflictResolution:
          dedup.conflictResolution === "none"
            ? null
            : (dedup.conflictResolution satisfies ConflictResolution),
        status: nextStatus,
        error: errorText,
      })
      .where(eq(importRecords.id, rec.id));

    processed += 1;
    if (processed % 25 === 0) {
      await broadcastD365Event({
        runId,
        event: D365_REALTIME_EVENTS.MAPPING_PROGRESS,
        payload: { batchId, processed, total: pending.length },
      });
    }

    // Phase 23 — halt the run if too much of the batch is garbage.
    // Only checks after a meaningful sample (10 records) so the very
    // first few being bad doesn't immediately halt the run.
    if (
      !halted &&
      processed >= HALT_MIN_SAMPLE &&
      shouldHaltOnGarbageVolume(garbageCount, processed)
    ) {
      await haltRun({
        runId,
        actorId,
        reason: D365_HALT_REASONS.BAD_LEAD_VOLUME,
        detail: {
          batchId,
          processed,
          garbageCount,
          ratio: Number((garbageCount / processed).toFixed(2)),
          message: `${garbageCount} of ${processed} records auto-skipped as bad-quality. Likely a known-bad import era — review the batch before continuing.`,
        },
      });
      halted = true;
    }
  }

  // Update batch counts + status (skip if halted — leave the batch in
  // its current state so the run-level pause is the source of truth).
  if (!halted) {
    await db
      .update(importBatches)
      .set({
        status: "reviewing",
        recordCountConflicts: conflictCount,
        reviewedAt: null,
      })
      .where(eq(importBatches.id, batchId));

    // Mark the run as reviewing too — the orchestrator owns the
    // life-cycle; this is the canonical signal that mapping is done.
    await db
      .update(importRuns)
      .set({ status: "reviewing" })
      .where(eq(importRuns.id, runId));
  }

  await broadcastD365Event({
    runId,
    event: D365_REALTIME_EVENTS.MAPPING_COMPLETED,
    payload: {
      batchId,
      recordCount: processed,
      conflictCount,
      warningCount,
      halted,
    },
  });

  return {
    recordCount: processed,
    conflictCount,
    warningCount,
  };
}
