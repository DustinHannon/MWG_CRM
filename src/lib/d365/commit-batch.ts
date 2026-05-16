import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { externalIds, importBatches, importRecords } from "@/db/schema/d365-imports";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { D365_AUDIT_EVENTS } from "./audit-events";
import type { D365EntityType } from "./types";

/**
 * Drizzle's `db.transaction()` callback parameter is a PgTransaction
 * which is not assignable to PostgresJsDatabase. We type the helpers
 * in this module against a shared minimum surface (`Tx`) so they can
 * accept either the top-level `db` or the in-transaction `tx`.
 *
 * Using `Parameters<typeof db.transaction>[0]` would be ideal but TS
 * narrows the union poorly here — the lighter `any`-shaped alias keeps
 * the call sites readable while letting the caller pass either kind.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * commit batch helper.
 *
 * Loads all approved records for a batch and, per-record, transactionally:
 * 1. Resolves the local row id via existing dedup metadata
 * (`conflictWith`) or a fresh `external_ids` lookup.
 * 2. Applies the chosen `conflictResolution`:
 * `dedup_skip` → no-op, mark record as skipped.
 * `dedup_overwrite` → UPDATE every non-null mapped column.
 * `dedup_merge` → UPDATE only fields that are NULL/empty
 * in the local row.
 * `dedup_none` / null → INSERT new row.
 * 3. Upserts an `external_ids` row.
 * 4. Stamps `import_records.localId` + `status='committed'`.
 *
 * Per-record failures isolate (status='failed', error stored) — they
 * do NOT roll back the batch. After all records process we update the
 * batch counters + status='committed' and audit.
 *
 * Sub-agent C calls this from `commitBatchAction`. The mapped payload
 * shape persisted by Sub-agent B's mappers (`NewLead`, `NewContact`,
 * `NewAccount`, `NewOpportunity`, etc.) is what we insert. Activities
 * insert into the unified `activities` table with the parent FK
 * resolved from the parent entity's `external_ids` row.
 *
 * NOTE: This is a pragmatic implementation. Sub-agent B may ship a
 * richer commit-batch later that handles more nuanced merge rules.
 * If this file is replaced, keep the same exported signature so
 * `commitBatchAction` doesn't need to change.
 */

export interface CommitBatchResult {
  committed: number;
  skipped: number;
  failed: number;
}

const PARENT_ENTITY_TABLES = {
  lead: leads,
  contact: contacts,
  account: crmAccounts,
  opportunity: opportunities,
} as const;

type ParentTable = (typeof PARENT_ENTITY_TABLES)[keyof typeof PARENT_ENTITY_TABLES];

const ACTIVITY_KIND: Record<string, "email" | "call" | "meeting" | "note" | "task"> = {
  annotation: "note",
  task: "task",
  phonecall: "call",
  appointment: "meeting",
  email: "email",
};

export async function commitBatch(
  batchId: string,
  actorId: string,
): Promise<CommitBatchResult> {
  // Deterministic commit order so FK lookups via `lookupLocalId`
  // succeed on the first pass:
  //   account → contact → opportunity → activities → other
  // Within a tier, ordered by createdAt so a parent account commits
  // before any child account that lists it as `_parentaccountid_value`.
  // If ordering still doesn't resolve (e.g., parent in a different
  // batch entirely), the FK stays null and a re-import picks it up.
  const records = await db
    .select({
      id: importRecords.id,
      sourceEntityType: importRecords.sourceEntityType,
      sourceId: importRecords.sourceId,
      mappedPayload: importRecords.mappedPayload,
      conflictResolution: importRecords.conflictResolution,
      conflictWith: importRecords.conflictWith,
      status: importRecords.status,
    })
    .from(importRecords)
    .where(eq(importRecords.batchId, batchId))
    .orderBy(
      sql`CASE ${importRecords.sourceEntityType}
            WHEN 'account' THEN 1
            WHEN 'contact' THEN 2
            WHEN 'opportunity' THEN 3
            WHEN 'lead' THEN 4
            ELSE 5
          END`,
      // Stable secondary order so identical-tier records commit in a
      // consistent sequence run-to-run. importRecords.id is a UUID;
      // ascending order is deterministic if not chronological.
      asc(importRecords.id),
    );

  // F-05: atomic state transition guards against concurrent commits.
  // Two simultaneous commitBatchAction clicks both pass the action-
  // level `status === "committed"` gate (read outside any lock), then
  // both enter `commitBatch` and process the same `approved` records,
  // producing duplicate entity rows. Session-scoped pg_advisory_lock
  // is unreliable under Supavisor transaction-mode pooling (the
  // underlying backend session changes between queries, so the lock
  // can be acquired but never blocks the second click). Instead we
  // flip `import_batches.status` from its review state to
  // `'committing'` via a conditional UPDATE: if zero rows changed,
  // another run already took the slot and we bounce with
  // ConflictError. The terminal status ('committed' or 'failed') is
  // set at the end of the loop.
  const lockResult = await db
    .update(importBatches)
    .set({ status: "committing" })
    .where(
      and(
        eq(importBatches.id, batchId),
        inArray(importBatches.status, [
          "reviewing",
          "approved",
          // F-12: a previously-failed batch is allowed to retry; this
          // matches the action-layer rule that already throws on
          // `status === "failed"` (admin must explicitly re-review),
          // so reaching here means status is reviewing/approved.
        ]),
      ),
    )
    .returning({ id: importBatches.id });
  if (lockResult.length === 0) {
    throw new ConflictError(
      "Another commit run is already in progress for this batch (or the batch is not in a committable state).",
      { batchId },
    );
  }

  let committed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const rec of records) {
      if (rec.status !== "approved") {
        // Rejected/skipped/failed/committed records are skipped here.
        continue;
      }

      try {
        const result = await commitOneRecord(rec, actorId);
        if (result.outcome === "committed") {
          committed += 1;
          await writeAudit({
            actorId,
            action: D365_AUDIT_EVENTS.RECORD_COMMITTED,
            targetType: "d365_import_record",
            targetId: rec.id,
            after: {
              sourceEntityType: rec.sourceEntityType,
              // Forensic linkage: name the CRM row this staged record
              // wrote and whether it was an INSERT or an UPDATE.
              // targetType/targetId stay the staging-record identity
              // (still useful); this enriches `after` only.
              crmEntityType: result.crmEntityType,
              crmEntityId: result.crmEntityId,
              operation: result.operation,
              // F-08: surface activity-reuse via subkind so a no-op
              // re-import (external_id already mapped) doesn't look
              // like a fresh write in the audit trail.
              ...(result.subkind ? { subkind: result.subkind } : {}),
              ...(result.before ? { before: result.before } : {}),
            },
          });
          // F-02: emit FK_UNRESOLVED audit AFTER the per-record tx
          // committed successfully. The prior in-tx emit ran via the
          // global `db` connection (writeAudit doesn't accept a tx
          // handle), so a tx that rolled back left orphan
          // FK_UNRESOLVED audit rows asserting events that never
          // actually happened.
          for (const u of result.unresolvedFks ?? []) {
            await writeAudit({
              actorId,
              action: D365_AUDIT_EVENTS.RECORD_FK_UNRESOLVED,
              targetType: "d365_import_record",
              targetId: rec.id,
              after: {
                sourceEntityType: rec.sourceEntityType,
                sourceId: rec.sourceId,
                field: u.field,
                foreignEntity: u.targetEntity,
                foreignSourceId: u.sourceId,
                remediation:
                  "re-import after the foreign record lands, or set manually via the edit form",
              },
            });
          }
        } else if (result.outcome === "skipped") {
          skipped += 1;
          await writeAudit({
            actorId,
            action: D365_AUDIT_EVENTS.RECORD_SKIPPED,
            targetType: "d365_import_record",
            targetId: rec.id,
            // F-07/F-09: emit the SPECIFIC reason instead of always
            // claiming "dedup_skip". A missing-parent activity skip
            // is forensically distinct from a reviewer-driven dedup
            // skip and audit consumers must be able to tell them apart.
            after: { reason: result.reason ?? "dedup_skip" },
          });
        }
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.error("d365.commit_record.failed", {
          recordId: rec.id,
          sourceEntityType: rec.sourceEntityType,
          errorMessage: message,
        });
        // F-12: wrap the failure-state update so a transient DB error
        // here can't leave the record in `approved` state (which would
        // cause it to be re-processed and double-write at the entity
        // level on the next click). If the row update itself fails we
        // log a structured marker that admins can grep for.
        try {
          await db
            .update(importRecords)
            .set({
              status: "failed",
              error: message.slice(0, 1000),
            })
            .where(eq(importRecords.id, rec.id));
        } catch (updateErr) {
          logger.error("d365.commit_record.status_update_failed", {
            recordId: rec.id,
            sourceEntityType: rec.sourceEntityType,
            originalErrorMessage: message,
            updateErrorMessage:
              updateErr instanceof Error
                ? updateErr.message
                : String(updateErr),
          });
        }
        // pair the row's status='failed' update with
        // a forensic audit row. writeAudit is best-effort; an audit
        // outage cannot block the commit-batch loop's remaining work.
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_COMMIT_FAILED,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: {
            sourceEntityType: rec.sourceEntityType,
            errorMessage: message.slice(0, 500),
          },
        });
      }
    }

    // F-10: status reflects actual outcome. A batch with any failures
    // is NOT 'committed' — it's 'failed', and the audit/admin UI must
    // surface that so the operator can investigate the failed rows
    // instead of treating the batch as a clean commit.
    // F-03: track skipped count via record_count_skipped (new column).
    await db
      .update(importBatches)
      .set({
        status: failed > 0 ? "failed" : "committed",
        committedAt: new Date(),
        recordCountCommitted: sql`${importBatches.recordCountCommitted} + ${committed}`,
        recordCountFailed: sql`${importBatches.recordCountFailed} + ${failed}`,
        recordCountSkipped: sql`${importBatches.recordCountSkipped} + ${skipped}`,
      })
      .where(eq(importBatches.id, batchId));

    return { committed, skipped, failed };
  } catch (err) {
    // F-05: if the loop crashes catastrophically (typecheck would
    // catch most paths but a runtime DB error could land here), put
    // the batch back into `reviewing` so a re-click can retry.
    // Otherwise the batch stays in `committing` forever and admin has
    // to manually unstick it. The actual per-record failures already
    // wrote `RECORD_COMMIT_FAILED` audit rows for forensics.
    await db
      .update(importBatches)
      .set({ status: "reviewing" })
      .where(eq(importBatches.id, batchId));
    throw err;
  }
}

interface UnresolvedFk {
  field: string;
  sourceId: string;
  targetEntity: string;
}

type CommitOneResult =
  | {
      outcome: "committed";
      subkind?: "already_existed";
      unresolvedFks?: UnresolvedFk[];
      before?: { version?: number };
      // Forensic linkage: which CRM row the staged record resolved to,
      // and whether it was a fresh INSERT or an UPDATE of an existing
      // row. Without this the RECORD_COMMITTED audit can only name the
      // staging-record id, not the lead/contact/account/opportunity it
      // actually wrote.
      crmEntityType: "lead" | "contact" | "account" | "opportunity" | "activity";
      crmEntityId: string;
      operation: "created" | "updated";
    }
  | {
      outcome: "skipped";
      reason: "dedup_skip" | "missing_parent";
    };

interface RecordRow {
  id: string;
  sourceEntityType: string;
  sourceId: string;
  mappedPayload: unknown;
  conflictResolution: string | null;
  conflictWith: string | null;
}

async function commitOneRecord(
  rec: RecordRow,
  actorId: string,
): Promise<CommitOneResult> {
  if (!rec.mappedPayload || typeof rec.mappedPayload !== "object") {
    throw new ValidationError("missing mappedPayload", { recordId: rec.id });
  }
  const wrapper = rec.mappedPayload as Record<string, unknown>;
  // map-batch persists mappedPayload as `{ mapped, attached, customFields }`
  // (see map-batch.ts). The actual insertable object lives at `wrapper.mapped`;
  // `wrapper.attached` and `wrapper.customFields` are sibling metadata that
  // must NOT flow to Drizzle. Defensive fallback: if upstream changes the
  // shape and writes the insertable object directly at the top, we still
  // unwrap correctly.
  const mappedRaw =
    wrapper.mapped && typeof wrapper.mapped === "object"
      ? (wrapper.mapped as Record<string, unknown>)
      : wrapper;

  // Extract `_`-prefixed virtuals BEFORE strip — commit-batch reads the
  // parent FK from these for the activity path AND for account/contact
  // FK resolution against external_ids.
  const parentEntityType =
    typeof mappedRaw._parentEntityType === "string"
      ? (mappedRaw._parentEntityType as string)
      : null;
  const parentSourceId =
    typeof mappedRaw._parentSourceId === "string"
      ? (mappedRaw._parentSourceId as string)
      : null;
  // Contact mapper stashes the D365 parent-customer GUID here; resolved
  // to a local crm_accounts.id below.
  const accountSourceId =
    typeof mappedRaw._accountSourceId === "string"
      ? (mappedRaw._accountSourceId as string)
      : null;
  // Account mapper stashes these for the two account-level FKs.
  const parentAccountSourceId =
    typeof mappedRaw._parentAccountSourceId === "string"
      ? (mappedRaw._parentAccountSourceId as string)
      : null;
  const primaryContactSourceId =
    typeof mappedRaw._primaryContactSourceId === "string"
      ? (mappedRaw._primaryContactSourceId as string)
      : null;

  // Strip every `_`-prefixed virtual (`_meta`, `_parentEntityType`,
  // `_parentSourceId`, `_qualityVerdict`, `_qualityReasons`,
  // `_accountSourceId`, `_parentAccountSourceId`,
  // `_primaryContactSourceId`, etc.) before Drizzle insert.
  const cleanPayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mappedRaw)) {
    if (k.startsWith("_")) continue;
    cleanPayload[k] = v;
  }

  const entityType = rec.sourceEntityType as D365EntityType;

  return await db.transaction(async (tx): Promise<CommitOneResult> => {
    // Resolve account/contact FKs from D365 source GUIDs into the
    // local rows that have been previously imported. If the foreign
    // record hasn't been imported yet, the FK stays null — the user
    // can either re-run the import (which will resolve on second pass)
    // or set the FK manually via the edit form. F-02: the
    // RECORD_FK_UNRESOLVED audit emission is DEFERRED to the outer
    // success branch in `commitBatch` so a tx rollback doesn't leave
    // false-positive audit rows asserting events that never happened.
    const unresolvedFks: UnresolvedFk[] = [];
    if (entityType === "contact" && accountSourceId) {
      const localAccountId = await lookupLocalId(tx, "account", accountSourceId);
      if (localAccountId) cleanPayload.accountId = localAccountId;
      else
        unresolvedFks.push({
          field: "accountId",
          sourceId: accountSourceId,
          targetEntity: "account",
        });
    }
    if (entityType === "account") {
      if (parentAccountSourceId) {
        const localParentId = await lookupLocalId(
          tx,
          "account",
          parentAccountSourceId,
        );
        if (localParentId) cleanPayload.parentAccountId = localParentId;
        else
          unresolvedFks.push({
            field: "parentAccountId",
            sourceId: parentAccountSourceId,
            targetEntity: "account",
          });
      }
      if (primaryContactSourceId) {
        const localContactId = await lookupLocalId(
          tx,
          "contact",
          primaryContactSourceId,
        );
        if (localContactId) cleanPayload.primaryContactId = localContactId;
        else
          unresolvedFks.push({
            field: "primaryContactId",
            sourceId: primaryContactSourceId,
            targetEntity: "contact",
          });
      }
    }

    // Activities path — insert into `activities` and link parent FK.
    if (
      entityType === "annotation" ||
      entityType === "task" ||
      entityType === "phonecall" ||
      entityType === "appointment" ||
      entityType === "email"
    ) {
      const result = await commitActivity(
        tx,
        entityType,
        rec.sourceId,
        cleanPayload,
        { entityType: parentEntityType, sourceId: parentSourceId },
        actorId,
      );
      if (result.outcome === "missing_parent") {
        // F-07: this is NOT a dedup skip — caller's audit must surface
        // the actual reason so operators distinguish missing-parent
        // skips from reviewer-driven dedup skips.
        await tx
          .update(importRecords)
          .set({
            status: "skipped",
            committedAt: new Date(),
            error: "parent entity not found locally",
          })
          .where(eq(importRecords.id, rec.id));
        return { outcome: "skipped", reason: "missing_parent" };
      }
      await tx
        .update(importRecords)
        .set({
          status: "committed",
          committedAt: new Date(),
          localId: result.localId,
        })
        .where(eq(importRecords.id, rec.id));
      // F-08: an idempotent re-import (external_id already mapped)
      // is forensically distinct from a fresh activity insert. Surface
      // via subkind so audit consumers can filter no-op re-runs. The
      // CRM row written is an `activities` row; `alreadyExisted` is the
      // existing created-vs-updated signal (re-import maps to an
      // already-present row → "updated"; fresh insert → "created").
      return result.alreadyExisted
        ? {
            outcome: "committed",
            subkind: "already_existed",
            unresolvedFks,
            crmEntityType: "activity",
            crmEntityId: result.localId,
            operation: "updated",
          }
        : {
            outcome: "committed",
            unresolvedFks,
            crmEntityType: "activity",
            crmEntityId: result.localId,
            operation: "created",
          };
    }

    // Parent entity path (lead / contact / account / opportunity).
    const parentResult = await commitParentEntity(
      tx,
      entityType,
      rec.sourceId,
      cleanPayload,
      rec.conflictWith,
      rec.conflictResolution,
      actorId,
    );
    if (parentResult.outcome === "dedup_skip") {
      // dedup_skip path
      await tx
        .update(importRecords)
        .set({
          status: "skipped",
          committedAt: new Date(),
        })
        .where(eq(importRecords.id, rec.id));
      return { outcome: "skipped", reason: "dedup_skip" };
    }

    await tx
      .update(importRecords)
      .set({
        status: "committed",
        committedAt: new Date(),
        localId: parentResult.localId,
      })
      .where(eq(importRecords.id, rec.id));
    return {
      outcome: "committed",
      unresolvedFks,
      // `entityType` is narrowed to a parent type here (activities
      // returned earlier). `beforeVersion` is set only on the
      // `conflictWith` UPDATE path (`commitParentEntity` returns it
      // from the existing-row branch); its absence means the INSERT
      // path ran — so it is the existing created-vs-updated signal.
      crmEntityType: entityType,
      crmEntityId: parentResult.localId,
      operation:
        parentResult.beforeVersion !== undefined ? "updated" : "created",
      // capture pre-update version on the audit `before` payload so a
      // concurrent user edit's OCC interaction is reconstructible from
      // the forensic trail. The D365 import is the documented
      // authoritative writer for D365-sourced records; the OCC
      // `WHERE version = $expected` clause is intentionally absent.
      // For `dedup_overwrite` resolution: a concurrent user write that
      // landed between the SELECT and the UPDATE is clobbered (by
      // design — overwrite means overwrite). For `dedup_merge`
      // resolution: the SET clause uses SQL-level `COALESCE` per
      // F-72 / STANDARDS §19.8, so concurrent user writes that filled
      // a previously-empty column are preserved.
      ...(parentResult.beforeVersion !== undefined
        ? { before: { version: parentResult.beforeVersion } }
        : {}),
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Parent entity commit *
 * -------------------------------------------------------------------------- */

type ParentCommitResult =
  | { outcome: "dedup_skip" }
  | { outcome: "committed"; localId: string; beforeVersion?: number };

async function commitParentEntity(
  tx: Tx,
  entityType: "lead" | "contact" | "account" | "opportunity",
  sourceId: string,
  payload: Record<string, unknown>,
  conflictWith: string | null,
  conflictResolution: string | null,
  actorId: string,
): Promise<ParentCommitResult> {
  const table = PARENT_ENTITY_TABLES[entityType];

  // dedup_skip — don't touch the local row.
  if (conflictResolution === "dedup_skip" && conflictWith) {
    await upsertExternalId(tx, entityType, sourceId, conflictWith);
    return { outcome: "dedup_skip" };
  }

  if (conflictWith) {
    // Update path
    const existing = await tx
      .select()
      .from(table)
      .where(eq(table.id, conflictWith))
      .limit(1);
    const existingRow = existing[0] as Record<string, unknown> | undefined;
    if (!existingRow) {
      // Conflict target disappeared (deleted between dedup and commit).
      // Fall through to insert.
      const localId = await insertParentEntity(
        tx,
        entityType,
        sourceId,
        payload,
        actorId,
      );
      return { outcome: "committed", localId };
    }

    const update =
      conflictResolution === "dedup_overwrite"
        ? buildOverwriteUpdate(payload)
        : buildMergeUpdate(payload, existingRow, table);

    // F-04: capture pre-update version (if the table tracks OCC) so the
    // audit `before` payload records the version the D365 import
    // clobbered. The import is the authoritative writer for D365-sourced
    // records — concurrent user edits lose silently, which is the
    // documented design, but the forensic trail needs to surface what
    // was clobbered.
    const beforeVersion =
      typeof existingRow.version === "number"
        ? (existingRow.version as number)
        : undefined;

    if (Object.keys(update).length > 0) {
      // Bump updated_by_id and updated_at where the columns exist; the
      // `version` column is bumped via SQL increment for OCC.
      const enriched: Record<string, unknown> = {
        ...update,
        updatedById: actorId,
        updatedAt: new Date(),
      };
      // Some tables track `version` for OCC — bump it via SQL.
      const versioned = table as unknown as { version?: unknown };
      if (versioned.version) {
        enriched.version = sql`${versioned.version as never} + 1`;
      }
      await tx
        .update(table)
        .set(enriched)
        .where(eq(table.id, conflictWith));
    }
    await upsertExternalId(tx, entityType, sourceId, conflictWith);
    return { outcome: "committed", localId: conflictWith, beforeVersion };
  }

  // Insert new path
  const localId = await insertParentEntity(
    tx,
    entityType,
    sourceId,
    payload,
    actorId,
  );
  return { outcome: "committed", localId };
}

async function insertParentEntity(
  tx: Tx,
  entityType: "lead" | "contact" | "account" | "opportunity",
  sourceId: string,
  payload: Record<string, unknown>,
  actorId: string,
): Promise<string> {
  const table = PARENT_ENTITY_TABLES[entityType];
  const clean: Record<string, unknown> = { ...payload };
  if (!clean.createdById) clean.createdById = actorId;
  if (!clean.updatedById) clean.updatedById = actorId;
  // The mapped payloads from Sub-agent B already match each table's
  // NewX shape (NewLead, NewContact, …). The cast keeps TS from
  // demanding the union narrow at the call site.
  const inserted = await tx
    .insert(table)
    .values(clean)
    .returning({ id: table.id });
  const row = inserted[0] as { id: string } | undefined;
  if (!row) {
    throw new ConflictError(`insert returned no row for ${entityType}`, {
      entityType,
      sourceId,
    });
  }
  await upsertExternalId(tx, entityType, sourceId, row.id);
  return row.id;
}

/**
 * Build a `set` payload for dedup_overwrite — every non-undefined
 * mapped column overrides the local. Drops `_meta` already.
 */
function buildOverwriteUpdate(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (k === "id" || k === "version") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build a `set` payload for dedup_merge (Q-03 default) — only fill
 * fields where the existing local value is null/undefined/empty
 * string.
 *
 * Concurrent-write safety (F-72): the `existing` snapshot is read at
 * the top of `commitParentEntity`. Between that SELECT and the UPDATE
 * fired here, a CRM user can have edited the same row. Emitting a
 * plain `SET first_name = $new` would clobber that edit silently. The
 * merge contract specifies the opposite — preserve user data — so we
 * wrap each value in `COALESCE(<column>, $new)`. The DB engine decides
 * at UPDATE time whether the column is still empty; concurrent fills
 * are preserved.
 *
 * The JS-side `isEmpty` snapshot check stays — it gates which columns
 * even enter the SET clause, so the UPDATE's write-set stays minimal.
 * The COALESCE wrapping handles the race within that already-narrow
 * set.
 *
 * STANDARDS §19.8 governs the sync pipeline idempotency contract.
 */
function buildMergeUpdate(
  payload: Record<string, unknown>,
  existing: Record<string, unknown>,
  table: ParentTable,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tableCols = table as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (k === "id" || k === "version") continue;
    const cur = existing[k];
    const isEmpty =
      cur === null ||
      cur === undefined ||
      (typeof cur === "string" && cur.length === 0);
    if (!isEmpty) continue;
    const col = tableCols[k];
    if (col === undefined) continue;
    // F-72: SQL-level COALESCE so a concurrent user write that landed
    // between the SELECT and this UPDATE is preserved by the DB engine
    // at apply-time. Without this, the merge contract is violated
    // silently when a user edits the same row during the D365 import's
    // commit window.
    out[k] = sql`COALESCE(${col as never}, ${v})`;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Activities path *
 * -------------------------------------------------------------------------- */

type ActivityCommitResult =
  | { outcome: "missing_parent" }
  | { outcome: "committed"; localId: string; alreadyExisted: boolean };

async function commitActivity(
  tx: Tx,
  entityType: "annotation" | "task" | "phonecall" | "appointment" | "email",
  sourceId: string,
  payload: Record<string, unknown>,
  parentRef: { entityType: string | null; sourceId: string | null },
  actorId: string,
): Promise<ActivityCommitResult> {
  // Parent FK resolution — caller passes the parent reference
  // explicitly (extracted from the unwrapped mapped object's
  // `_parentEntityType` / `_parentSourceId` virtuals before the
  // `_*` strip).
  const parentEntityType = parentRef.entityType;
  const parentSourceId = parentRef.sourceId;

  let parentLocalId: string | null = null;
  if (parentEntityType && parentSourceId) {
    const rows = await tx
      .select({ localId: externalIds.localId })
      .from(externalIds)
      .where(
        and(
          eq(externalIds.source, "d365"),
          eq(externalIds.sourceEntityType, parentEntityType),
          eq(externalIds.sourceId, parentSourceId),
        ),
      )
      .limit(1);
    parentLocalId = rows[0]?.localId ?? null;
  }

  if (!parentLocalId) {
    return { outcome: "missing_parent" };
  }

  // Idempotent: if external_ids already maps this activity, update
  // its existing row; otherwise insert. F-08: signal the
  // already-existed case so the caller's audit can flag the re-import
  // as a no-op instead of claiming a fresh write.
  const existing = await tx
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, "d365"),
        eq(externalIds.sourceEntityType, entityType),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);

  const kind = ACTIVITY_KIND[entityType];
  const occurredAt =
    typeof payload.occurredAt === "string" || payload.occurredAt instanceof Date
      ? new Date(payload.occurredAt as string | Date)
      : new Date();
  const subject =
    typeof payload.subject === "string" ? (payload.subject as string) : null;
  const body =
    typeof payload.body === "string" ? (payload.body as string) : null;

  if (existing[0]) {
    return {
      outcome: "committed",
      localId: existing[0].localId,
      alreadyExisted: true,
    };
  }

  const inserted = await tx
    .insert(activities)
    .values({
      kind,
      leadId: parentEntityType === "lead" ? parentLocalId : null,
      contactId: parentEntityType === "contact" ? parentLocalId : null,
      accountId: parentEntityType === "account" ? parentLocalId : null,
      opportunityId: parentEntityType === "opportunity" ? parentLocalId : null,
      occurredAt,
      subject,
      body,
      createdById: actorId,
      updatedById: actorId,
    } as typeof activities.$inferInsert)
    .returning({ id: activities.id });
  const row = inserted[0];
  if (!row) {
    throw new ConflictError("activity insert returned no row", {
      entityType,
      sourceId,
    });
  }

  await upsertExternalId(tx, entityType, sourceId, row.id);
  return { outcome: "committed", localId: row.id, alreadyExisted: false };
}

/* -------------------------------------------------------------------------- *
 * external_ids upsert *
 * -------------------------------------------------------------------------- */

/**
 * Resolve a D365 GUID for a related record to the local UUID using
 * the external_ids table. Returns null when the foreign record hasn't
 * been imported yet — callers leave the FK null in that case.
 */
async function lookupLocalId(
  tx: Tx,
  entityType: "account" | "contact" | "lead" | "opportunity",
  sourceId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, "d365"),
        eq(externalIds.sourceEntityType, entityType),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows[0]?.localId ?? null;
}

async function upsertExternalId(
  tx: Tx,
  entityType: D365EntityType,
  sourceId: string,
  localId: string,
): Promise<void> {
  const localEntityType =
    entityType === "annotation" ||
    entityType === "task" ||
    entityType === "phonecall" ||
    entityType === "appointment" ||
    entityType === "email"
      ? "activity"
      : entityType === "account"
        ? "account"
        : entityType;

  // F-01: atomic upsert against `extid_source_sourceid_idx` unique
  // constraint. The prior check-then-insert pattern lost the race
  // under READ COMMITTED — two concurrent commit-batch runs could
  // both miss the SELECT and both attempt INSERT, throwing a unique
  // violation. ON CONFLICT DO UPDATE makes the second writer win
  // idempotently while still refreshing localId + lastSyncedAt.
  await tx
    .insert(externalIds)
    .values({
      source: "d365",
      sourceEntityType: entityType,
      sourceId,
      localEntityType,
      localId,
    })
    .onConflictDoUpdate({
      target: [
        externalIds.source,
        externalIds.sourceEntityType,
        externalIds.sourceId,
      ],
      set: {
        localId,
        lastSyncedAt: new Date(),
      },
    });
}
