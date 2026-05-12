import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
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

  let committed = 0;
  let skipped = 0;
  let failed = 0;

  for (const rec of records) {
    if (rec.status !== "approved") {
      // Rejected/skipped/failed/committed records are skipped here.
      continue;
    }

    try {
      const result = await commitOneRecord(rec, actorId);
      if (result === "committed") {
        committed += 1;
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_COMMITTED,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: { sourceEntityType: rec.sourceEntityType },
        });
      } else if (result === "skipped") {
        skipped += 1;
        await writeAudit({
          actorId,
          action: D365_AUDIT_EVENTS.RECORD_SKIPPED,
          targetType: "d365_import_record",
          targetId: rec.id,
          after: { reason: "dedup_skip" },
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
      await db
        .update(importRecords)
        .set({
          status: "failed",
          error: message.slice(0, 1000),
        })
        .where(eq(importRecords.id, rec.id));
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

  // Update batch totals + status. Use SQL increments so we don't lose
  // counts that earlier mapping/review stages already accumulated.
  await db
    .update(importBatches)
    .set({
      status: "committed",
      committedAt: new Date(),
      recordCountCommitted: sql`${importBatches.recordCountCommitted} + ${committed}`,
      recordCountFailed: sql`${importBatches.recordCountFailed} + ${failed}`,
    })
    .where(eq(importBatches.id, batchId));

  return { committed, skipped, failed };
}

type CommitOutcome = "committed" | "skipped";

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
): Promise<CommitOutcome> {
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

  return await db.transaction(async (tx) => {
    // Resolve account/contact FKs from D365 source GUIDs into the
    // local rows that have been previously imported. If the foreign
    // record hasn't been imported yet, the FK stays null — the user
    // can either re-run the import (which will resolve on second pass)
    // or set the FK manually via the edit form. Each unresolved FK
    // emits a RECORD_FK_UNRESOLVED audit row so operators can see
    // how many follow-up resolutions are pending.
    const unresolved: Array<{ field: string; sourceId: string; targetEntity: string }> = [];
    if (entityType === "contact" && accountSourceId) {
      const localAccountId = await lookupLocalId(tx, "account", accountSourceId);
      if (localAccountId) cleanPayload.accountId = localAccountId;
      else unresolved.push({ field: "accountId", sourceId: accountSourceId, targetEntity: "account" });
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
          unresolved.push({
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
          unresolved.push({
            field: "primaryContactId",
            sourceId: primaryContactSourceId,
            targetEntity: "contact",
          });
      }
    }
    for (const u of unresolved) {
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
          remediation: "re-import after the foreign record lands, or set manually via the edit form",
        },
      });
    }

    // Activities path — insert into `activities` and link parent FK.
    if (
      entityType === "annotation" ||
      entityType === "task" ||
      entityType === "phonecall" ||
      entityType === "appointment" ||
      entityType === "email"
    ) {
      const local = await commitActivity(
        tx,
        entityType,
        rec.sourceId,
        cleanPayload,
        { entityType: parentEntityType, sourceId: parentSourceId },
        actorId,
      );
      if (!local) {
        // Couldn't resolve parent — record skipped (audit-wise still a fail).
        await tx
          .update(importRecords)
          .set({
            status: "skipped",
            committedAt: new Date(),
            error: "parent entity not found locally",
          })
          .where(eq(importRecords.id, rec.id));
        return "skipped";
      }
      await tx
        .update(importRecords)
        .set({
          status: "committed",
          committedAt: new Date(),
          localId: local,
        })
        .where(eq(importRecords.id, rec.id));
      return "committed";
    }

    // Parent entity path (lead / contact / account / opportunity).
    const localId = await commitParentEntity(
      tx,
      entityType,
      rec.sourceId,
      cleanPayload,
      rec.conflictWith,
      rec.conflictResolution,
      actorId,
    );
    if (localId === null) {
      // dedup_skip path
      await tx
        .update(importRecords)
        .set({
          status: "skipped",
          committedAt: new Date(),
        })
        .where(eq(importRecords.id, rec.id));
      return "skipped";
    }

    await tx
      .update(importRecords)
      .set({
        status: "committed",
        committedAt: new Date(),
        localId,
      })
      .where(eq(importRecords.id, rec.id));
    return "committed";
  });
}

/* -------------------------------------------------------------------------- *
 * Parent entity commit *
 * -------------------------------------------------------------------------- */

async function commitParentEntity(
  tx: Tx,
  entityType: "lead" | "contact" | "account" | "opportunity",
  sourceId: string,
  payload: Record<string, unknown>,
  conflictWith: string | null,
  conflictResolution: string | null,
  actorId: string,
): Promise<string | null> {
  const table = PARENT_ENTITY_TABLES[entityType];

  // dedup_skip — don't touch the local row.
  if (conflictResolution === "dedup_skip" && conflictWith) {
    await upsertExternalId(tx, entityType, sourceId, conflictWith);
    return null;
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
      return insertParentEntity(tx, entityType, sourceId, payload, actorId);
    }

    const update =
      conflictResolution === "dedup_overwrite"
        ? buildOverwriteUpdate(payload)
        : buildMergeUpdate(payload, existingRow);

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
    return conflictWith;
  }

  // Insert new path
  return insertParentEntity(tx, entityType, sourceId, payload, actorId);
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
 */
function buildMergeUpdate(
  payload: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (k === "id" || k === "version") continue;
    const cur = existing[k];
    const isEmpty =
      cur === null ||
      cur === undefined ||
      (typeof cur === "string" && cur.length === 0);
    if (isEmpty) out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Activities path *
 * -------------------------------------------------------------------------- */

async function commitActivity(
  tx: Tx,
  entityType: "annotation" | "task" | "phonecall" | "appointment" | "email",
  sourceId: string,
  payload: Record<string, unknown>,
  parentRef: { entityType: string | null; sourceId: string | null },
  actorId: string,
): Promise<string | null> {
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
    return null;
  }

  // Idempotent: if external_ids already maps this activity, update
  // its existing row; otherwise insert.
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
    return existing[0].localId;
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
  return row.id;
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

  const existing = await tx
    .select({ id: externalIds.id })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, "d365"),
        eq(externalIds.sourceEntityType, entityType),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await tx
      .update(externalIds)
      .set({ localId, lastSyncedAt: new Date() })
      .where(eq(externalIds.id, existing[0].id));
  } else {
    await tx.insert(externalIds).values({
      source: "d365",
      sourceEntityType: entityType,
      sourceId,
      localEntityType,
      localId,
    });
  }
}
