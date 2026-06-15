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
  dedupContact,
  dedupLead,
  dedupOpportunity,
  type ConflictResolution,
  type DedupResult,
} from "./dedup";
import {
  mapD365Account,
  mapD365Contact,
  mapD365Lead,
  mapD365Opportunity,
  MappingError,
  isChildWarning,
  type ChildOwnerResolver,
  type D365Children,
  type MapResult,
  type ValidationWarning,
} from "./mapping";
import { resolveD365Owner } from "./owner-mapping";
import { shouldHaltOnGarbageVolume } from "./quality";
import {
  detectBatchHalt,
  type ImportRecordForDetect,
} from "./halt-detection";
import { isD365RootType, type D365RootType } from "./queries";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type {
  D365Account,
  D365Contact,
  D365EntityType,
  D365Lead,
  D365Opportunity,
} from "./types";

/**
 * `mapBatch` orchestrator.
 *
 * Loads pending `import_records` for a batch, runs the right mapper,
 * then dedup, then persists the mappedPayload + warnings + conflict
 * resolution. Halts the run on an unmapped picklist (per-record), a
 * bad-lead-volume spike, or — after the per-record loop — a
 * batch-level threshold halt (high-volume conflict / owner-JIT
 * failure / validation regression).
 *
 * Realtime broadcast is delegated to `broadcastD365Event`, which
 * publishes on the per-run Supabase channel via `broadcastRunEvent`.
 */

export interface MapBatchResult {
  recordCount: number;
  conflictCount: number;
  warningCount: number;
}

/**
 * Resolve a D365 owner GUID + cached email lookup → mwg-crm user id.
 * The pull-batch flow attaches the resolved owner email to each stored
 * raw record (root AND every child) under the `_ownerid_value_email`
 * synthetic key. Pass the ROOT record (`rawPayload.root`) for the
 * root's owner, or a child raw for a child's owner. If absent, the
 * resolver falls back to the default owner.
 */
function getOwnerEmailFromRaw(
  raw: Record<string, unknown>,
): string | null | undefined {
  // pull-batch stores the resolved email under a synthetic
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
 * Thin wrapper over `broadcastRunEvent`. Centralises the typed
 * event-name lookup so map-batch never references string literals
 * (every event flows through `D365_REALTIME_EVENTS`).
 */
async function broadcastD365Event(args: {
  runId: string;
  event: D365RealtimeEvent;
  payload: Record<string, unknown>;
}): Promise<void> {
  await broadcastRunEvent(args.runId, args.event, args.payload);
}

/**
 * Halt the run with a reason: append a JSON-line halt note, flip the
 * run to `paused_for_review`, audit `RUN_HALTED`, and broadcast.
 */
async function haltRun(args: {
  runId: string;
  actorId: string;
  reason: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  // JSON-line note shape MUST match the contract read by the
  // run-detail page's parseHaltFromNotes (`kind: "halt"` + `reason:
  // <D365HaltReason>`).
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
 * Root-aggregate unwrap *
 * -------------------------------------------------------------------------- */

/**
 * Per-root persisted shape under `import_records.rawPayload` — mirrors
 * `RootAggregatePayload` written by `pull-batch`. `root` is the raw
 * (owner-enriched) D365 root record; `children` holds the stitched
 * raw child arrays (the five `D365Children` keys only). Originated
 * opportunities are NOT grafted onto a lead — opportunity is a root type
 * imported via its own run, so it is never mapped as a child of a lead.
 */
interface RootAggregateRaw {
  root: Record<string, unknown>;
  children?: D365Children;
  _sourceOwnerId?: string | null;
}

/**
 * Narrow the persisted `rawPayload` to the root-aggregate shape. The
 * pull slice always persists `{ root, children, _sourceOwnerId }` for a
 * ROOT record; if `root` is missing the record is malformed (e.g. a
 * legacy pre-redesign row) — surface it as a typed validation failure
 * so the per-record catch flips it to `status='failed'` instead of
 * crashing the batch.
 */
function unwrapRootAggregate(
  raw: Record<string, unknown>,
): RootAggregateRaw {
  const root = raw["root"];
  if (root == null || typeof root !== "object") {
    throw new MappingError(
      "root",
      "Import record is not a root-aggregate payload (missing `root`). Re-pull the run with the current pipeline.",
    );
  }
  const childrenRaw = raw["children"];
  const children =
    childrenRaw != null && typeof childrenRaw === "object"
      ? (childrenRaw as RootAggregateRaw["children"])
      : undefined;
  return {
    root: root as Record<string, unknown>,
    children,
    _sourceOwnerId:
      typeof raw["_sourceOwnerId"] === "string"
        ? (raw["_sourceOwnerId"] as string)
        : null,
  };
}

/**
 * Project the persisted children to the five `D365Children` keys the root
 * mapper consumes. Destructured (not passed through) so a legacy row that
 * still carries the removed lead→opportunity graft key never reaches the
 * mapper — grafted opportunities import via their own opportunity root
 * run, not as a child of a lead.
 */
function toD365Children(
  children: RootAggregateRaw["children"],
): D365Children | undefined {
  if (!children) return undefined;
  const { task, phonecall, appointment, email, annotation } =
    children as D365Children & { opportunity?: unknown };
  return { task, phonecall, appointment, email, annotation };
}

/* -------------------------------------------------------------------------- *
 * Dispatcher *
 * -------------------------------------------------------------------------- */

/**
 * Run the ROOT mapper for the record's root type over the unwrapped
 * root record, passing the nested children + a child-owner resolver so
 * the mapper populates `result.attached` (the child graph). Only the
 * four root types are valid here — pull-batch already rejects child
 * types as a unit of work, but we re-narrow defensively so a malformed
 * `sourceEntityType` becomes a typed failure rather than an unmapped
 * branch.
 */
async function dispatchMap(
  rootType: D365RootType,
  root: Record<string, unknown>,
  ctx: {
    resolvedOwnerId: string;
    resolvedUserId: string | null;
    children: D365Children | undefined;
    resolveChildOwnerId?: ChildOwnerResolver;
  },
): Promise<MapResult<unknown>> {
  switch (rootType) {
    case "lead":
      return mapD365Lead(root as unknown as D365Lead, {
        resolvedOwnerId: ctx.resolvedOwnerId,
        children: ctx.children,
        resolveChildOwnerId: ctx.resolveChildOwnerId,
      }) as MapResult<unknown>;
    case "contact":
      return mapD365Contact(root as unknown as D365Contact, {
        resolvedOwnerId: ctx.resolvedOwnerId,
        resolvedCreatedById: ctx.resolvedUserId,
        resolvedUpdatedById: ctx.resolvedUserId,
        children: ctx.children,
        resolveChildOwnerId: ctx.resolveChildOwnerId,
      }) as MapResult<unknown>;
    case "account":
      return mapD365Account(root as unknown as D365Account, {
        resolvedOwnerId: ctx.resolvedOwnerId,
        children: ctx.children,
        resolveChildOwnerId: ctx.resolveChildOwnerId,
      }) as MapResult<unknown>;
    case "opportunity":
      return mapD365Opportunity(root as unknown as D365Opportunity, {
        resolvedOwnerId: ctx.resolvedOwnerId,
        children: ctx.children,
        resolveChildOwnerId: ctx.resolveChildOwnerId,
      }) as MapResult<unknown>;
    default: {
      const _exhaustive: never = rootType;
      void _exhaustive;
      // invariant: TypeScript exhaustive-check above guarantees this
      // branch is unreachable. If we ever land here, a new root type
      // was added without registering a mapper in this dispatch.
      throw new Error(`Unknown root type in dispatchMap: ${rootType}`);
    }
  }
}

/**
 * Dedup the ROOT against existing local rows. Only root types are
 * persisted as records now (children dedup at commit time via
 * external_ids inside the root's transaction), so this only ever sees
 * the four root types.
 */
async function dispatchDedup(
  rootType: D365RootType,
  mapped: unknown,
  externalId: string,
): Promise<DedupResult> {
  switch (rootType) {
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
    default: {
      const _exhaustive: never = rootType;
      void _exhaustive;
      // invariant: TypeScript exhaustive-check above guarantees this
      // branch is unreachable. If we ever land here, a new root type
      // was added without a dedup helper in this dispatch.
      throw new Error(`Unknown root type in dispatchDedup: ${rootType}`);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Child-owner pre-resolution *
 * -------------------------------------------------------------------------- */

/**
 * Owner resolution (`resolveD365Owner`) is async (it may JIT-provision a
 * user via Graph), but `mapAttachedChildren` needs a SYNC resolver. So
 * we pre-resolve every distinct child-owner email in the root's child
 * graph up front, cache it in a Map, and hand the mapper a sync closure
 * that reads the Map. A child whose owner can't be resolved (or carries
 * no enriched email) falls back to the root's resolved owner inside
 * `mapAttachedChildren`.
 */
async function buildChildOwnerResolver(
  children: D365Children | undefined,
  actorId: string,
): Promise<ChildOwnerResolver | undefined> {
  if (!children) return undefined;

  // Collect distinct enriched owner emails across every child array.
  const emails = new Set<string>();
  for (const arr of [
    children.task,
    children.phonecall,
    children.appointment,
    children.email,
    children.annotation,
  ]) {
    for (const child of arr ?? []) {
      const email = getOwnerEmailFromRaw(child as Record<string, unknown>);
      if (typeof email === "string" && email.length > 0) {
        emails.add(email);
      }
    }
  }
  if (emails.size === 0) return undefined;

  // Resolve each distinct email once (resolveD365Owner is itself cached
  // per lambda instance, so repeated runs share the lookups).
  const emailToUserId = new Map<string, string | null>();
  for (const email of emails) {
    const resolved = await resolveD365Owner(email, actorId);
    // A default-owner fallback means the child's true owner was
    // unresolvable; record null so the sync closure returns null and
    // mapAttachedChildren rides the child on the ROOT's owner instead
    // of attributing it to the default owner (the root's owner is the
    // better local proxy for an in-graph child).
    emailToUserId.set(
      email,
      resolved.source === "default_owner" ? null : resolved.userId,
    );
  }

  return (childRaw: Record<string, unknown>): string | null => {
    const email = getOwnerEmailFromRaw(childRaw);
    if (typeof email !== "string" || email.length === 0) return null;
    return emailToUserId.get(email) ?? null;
  };
}

/* -------------------------------------------------------------------------- *
 * mapBatch *
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
    // Domain — caller may pass a batchId that was deleted between
    // fetch and process (e.g. admin aborted the run). Typed so the
    // server action's error boundary returns a clean 404-style result
    // instead of an opaque 500.
    throw new NotFoundError("import_batch");
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
  // garbage-quality records auto-skip via the
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
      // ROOT-AGGREGATE: every persisted record is one ROOT (lead /
      // contact / account / opportunity) carrying its child graph under
      // `rawPayload.children`. Children are NEVER persisted standalone,
      // so a non-root sourceEntityType is a malformed record — reject it
      // as a typed validation failure (the catch flips it to 'failed').
      if (!isD365RootType(entityType)) {
        throw new ValidationError(
          `Import record has a non-root sourceEntityType '${entityType}'; only lead/contact/account/opportunity roots are mapped.`,
        );
      }
      const rootType = entityType;
      const { root, children: rawChildren } = unwrapRootAggregate(raw);
      const children = toD365Children(rawChildren);

      // Resolve the ROOT owner (off the enriched `rawPayload.root`). The
      // root mapper consumes `resolvedOwnerId`; the same user backs
      // `resolvedCreatedById`/`resolvedUpdatedById` on the contact path.
      const ownerEmail = getOwnerEmailFromRaw(root);
      const owner = await resolveD365Owner(ownerEmail, actorId);

      // Pre-resolve each distinct child owner (async) into a Map and
      // hand the mapper a sync closure — `mapAttachedChildren` needs a
      // sync resolver but owner resolution may JIT via Graph.
      const resolveChildOwnerId = await buildChildOwnerResolver(
        children,
        actorId,
      );

      const result = await dispatchMap(rootType, root, {
        resolvedOwnerId: owner.userId,
        resolvedUserId: owner.userId,
        children,
        resolveChildOwnerId,
      });
      warnings = result.warnings;
      // Emit an aggregated, low-severity marker when the D365 owner
      // could not be resolved to a user and fell back to the
      // configured default owner. This feeds the batch-level
      // owner-JIT-failure halt counter (detectOwnerJitFailure keys on
      // this code) WITHOUT forcing every default-owner record into
      // per-record review — former-employee-owned rows are common in
      // legacy data; a per-record gate on each would defeat the point
      // of having a default owner. The per-record `review` escalation
      // below and detectValidationRegression both exclude this code.
      if (owner.source === "default_owner") {
        warnings.push({
          field: "ownerId",
          code: "owner_default_owner_used",
          message:
            "D365 owner could not be resolved to a user; assigned to the configured default owner.",
        });
      }
      mappedPayload = {
        mapped: result.mapped,
        attached: result.attached,
        customFields: result.customFields,
      };

      dedup = await dispatchDedup(
        rootType,
        result.mapped,
        rec.sourceId,
      );

      if (dedup.conflictWith) {
        conflictCount += 1;
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_FLAGGED_CONFLICT,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: {
            conflictWith: dedup.conflictWith,
            matchedBy: dedup.matchedBy,
            entityType,
          },
        });
      }

      // Default-owner fallback is an expected, resolvable condition
      // (not a data problem), so it is excluded from the per-record
      // `review` escalation — it is handled at the batch level by the
      // owner-JIT-failure halt instead. CHILD-origin warnings are also
      // excluded: a bad child (unmapped picklist on a call, an
      // "Untitled task" default) must never force its ROOT to manual
      // review — children.ts's contract is "a bad child must not sink the
      // root graph". Child warnings are still persisted (below) so the
      // reviewer sees them non-fatally. A record carrying ONLY excluded
      // markers still maps cleanly and stays `mapped`.
      const reviewWorthyWarnings = warnings.filter(
        (w) => w.code !== "owner_default_owner_used" && !isChildWarning(w.field),
      );
      if (reviewWorthyWarnings.length > 0) {
        nextStatus = "review";
      }
      // Count ROOT-scoped warnings only (the returned tally feeds the
      // run summary; child warnings are non-fatal and excluded so they
      // don't inflate it).
      warningCount += warnings.filter((w) => !isChildWarning(w.field)).length;

      // bad-lead quality auto-skip. The lead mapper writes
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
          targetType: "d365_import_record",
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
      // fire on records we'd otherwise commit. CHILD-origin unmapped
      // picklists (e.g. an activity prioritycode/statecode) are excluded:
      // a bad child must not halt the whole run (children.ts's contract).
      const rootUnmappedPicklists = warnings.filter(
        (w) => w.code === "unmapped_picklist" && !isChildWarning(w.field),
      );
      // An unmapped ROOT picklist no longer halts the whole run. Real D365
      // orgs use CUSTOM option-sets (e.g. lead statuscode 100000xxx) on
      // essentially every record, so a run-wide halt paused the import on
      // the first record of every batch — unusable (verified against the
      // live org). Instead the record is routed to `review` so the operator
      // resolves it per-record (the human-in-the-loop safety, without
      // blocking the run); the raw picklist value is preserved in
      // raw_payload. Child-origin picklist warnings are already excluded
      // above per children.ts's contract.
      if (nextStatus !== "skipped" && rootUnmappedPicklists.length > 0) {
        nextStatus = "review";
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
        // Pair the row's status='failed' with a forensic audit row so
        // the failure class is reconstructible from audit_log alone
        // (not just transient logger output). Bare run `actorId`;
        // targetType is the canonical `d365_import_record` used by
        // commit-batch + the admin d365 actions so target_type filters
        // surface validation failures alongside the other record
        // events. writeAudit is best-effort.
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_VALIDATION_FAILED,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: {
            reason: errorText,
            errorClass: "MappingError",
            entityType,
            sourceId: rec.sourceId,
          },
        });
      } else {
        nextStatus = "failed";
        errorText = err instanceof Error ? err.message : String(err);
        logger.error("d365.map_batch.unexpected_error", {
          batchId,
          recordId: rec.id,
          errorMessage: errorText,
        });
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_VALIDATION_FAILED,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: {
            reason: errorText,
            errorClass: "unexpected",
            entityType,
            sourceId: rec.sourceId,
          },
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

    // halt the run if too much of the batch is garbage.
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

  // Batch-level threshold halts (high-volume conflict / owner-JIT
  // failure / validation regression). Evaluated once over the records
  // just persisted, after the per-record loop, only if no per-record
  // halt already fired. `unmapped_picklist` is excluded here because
  // it is already handled inline per-record above — letting
  // detectBatchHalt's picklist branch fire again would double-halt.
  if (!halted) {
    const detectRows = await db
      .select({
        id: importRecords.id,
        validationWarnings: importRecords.validationWarnings,
        conflictWith: importRecords.conflictWith,
        mappedPayload: importRecords.mappedPayload,
      })
      .from(importRecords)
      .where(eq(importRecords.batchId, batchId));
    const batchHalt = detectBatchHalt(
      detectRows as ImportRecordForDetect[],
    );
    if (batchHalt && batchHalt.reason !== "unmapped_picklist") {
      const reason =
        batchHalt.reason === "high_volume_conflict"
          ? D365_HALT_REASONS.HIGH_VOLUME_CONFLICT
          : batchHalt.reason === "owner_jit_failure"
            ? D365_HALT_REASONS.OWNER_JIT_FAILURE
            : D365_HALT_REASONS.VALIDATION_REGRESSION;
      await haltRun({
        runId,
        actorId,
        reason,
        detail: { batchId, ...batchHalt.detail },
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
