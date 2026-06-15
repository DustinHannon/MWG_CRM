import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import {
  externalIds,
  importBatches,
  importRecords,
} from "@/db/schema/d365-imports";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import { writeAudit } from "@/lib/audit";
import { ConflictError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { D365_AUDIT_EVENTS } from "./audit-events";

/**
 * Drizzle's `db.transaction()` callback parameter is a PgTransaction
 * which is not assignable to PostgresJsDatabase. We type the helpers
 * in this module against a shared minimum surface (`Tx`) so they can
 * accept either the top-level `db` or the in-transaction `tx`.
 *
 * Using `Parameters<typeof db.transaction>[0]` would be ideal but TS
 * narrows the union poorly here — the lighter alias keeps the call
 * sites readable while letting the caller pass either kind.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * commit batch helper — root-aggregate model.
 *
 * Every approved `import_records` row is a ROOT entity (lead / contact
 * / account / opportunity) carrying its full child graph (tasks /
 * phonecalls / appointments / emails / notes) in
 * `mappedPayload.attached`. CHILD types are never imported standalone.
 *
 * Per approved root, ONE `db.transaction`:
 *  1. RE-HYDRATE every date string back to `Date` for the root and
 *     every child (createdAt / updatedAt / closedAt / dueAt /
 *     completedAt / birthdate / occurredAt). The mapped payloads
 *     round-trip through `import_records.mapped_payload` (plain JSONB)
 *     and come back as strings; Drizzle's timestamp driver calls
 *     `.toISOString()` on them, so without this every insert throws a
 *     `TypeError`. This is the universal-commit-crash fix.
 *  2. Resolve the root's cross-root FKs from `external_ids`
 *     (contact→account; account→parentAccount/primaryContact;
 *     opportunity→account/primaryContact/originatingLead), then upsert
 *     the root into its table and write/upsert its `external_ids` row,
 *     capturing the in-memory local UUID.
 *  3. For each attached child: insert with the parent FK
 *     (leadId/accountId/contactId/opportunityId) set to that in-memory
 *     root UUID — NO external_ids lookup, so the FK can never miss.
 *     Tasks → `tasks` table (dedup via external_ids, no dedup column on
 *     tasks); phonecall/appointment/email/annotation → `activities`
 *     with per-parent `ON CONFLICT (<parentFk>, import_dedup_key)`.
 *     Write each child's `external_ids` row.
 *  4. All-or-nothing per root: one bad root isolates (status='failed',
 *     error stored) and the batch continues.
 *
 * Recency preservation (§5.2) rides through the mapped payloads
 * verbatim (createdAt/updatedAt = D365 createdon/modifiedon). The
 * cross-root dependency order account→contact→lead→opportunity makes
 * a root's parents exist in `external_ids` before it commits; any
 * still-null cross-root FK is swept by `reconcileRunFks` after the run.
 *
 * Called from `commitBatchAction`.
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

type RootEntityType = "lead" | "contact" | "account" | "opportunity";

/**
 * mwg-crm `activities.kind` for each non-task D365 child source type.
 * Tasks route into the `tasks` table instead, so they are excluded.
 */
const ACTIVITY_KIND: Record<string, "email" | "call" | "meeting" | "note"> = {
  annotation: "note",
  phonecall: "call",
  appointment: "meeting",
  email: "email",
};

/** Parent-FK column name on `activities` / `tasks` per root entity type. */
const PARENT_FK_COLUMN: Record<RootEntityType, "leadId" | "accountId" | "contactId" | "opportunityId"> = {
  lead: "leadId",
  account: "accountId",
  contact: "contactId",
  opportunity: "opportunityId",
};

/**
 * Date-bearing keys across every insertable shape we commit. The mapped
 * payloads produce real `Date`s, but they round-trip through JSONB and
 * arrive back as ISO strings; Drizzle's timestamp driver requires a
 * `Date`. We re-hydrate exactly these keys (a string that parses to a
 * valid date becomes a `Date`; anything else is left untouched so the
 * column's own coercion / NOT-NULL handling applies).
 */
const DATE_KEYS: readonly string[] = [
  "createdAt",
  "updatedAt",
  "closedAt",
  "dueAt",
  "completedAt",
  "occurredAt",
  "deletedAt",
];

/**
 * Cap on the number of child rows embedded in a RECORD_COMMITTED audit
 * `after.children` array, so a root with a pathological child fan-out
 * can't bloat a single forensic audit row to multiple megabytes. The
 * true total always rides on `childCount`; `childrenTruncated` flags when
 * the embedded list was capped (§12 aggregate-with-sample contract).
 */
const RECORD_COMMITTED_CHILDREN_CAP = 100;

/**
 * Re-hydrate ISO date strings back to `Date` for the known timestamp
 * columns. Mutates a shallow copy — the caller's object is untouched.
 *
 * `birthdate` is intentionally NOT in {@link DATE_KEYS}: it is a
 * `date` (date-only) column whose Drizzle driver accepts the
 * `YYYY-MM-DD` string the contact mapper emits, and re-hydrating it to
 * a `Date` would reintroduce a timezone-shift bug. We leave it as the
 * string it already is.
 */
function rehydrateDates(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const key of DATE_KEYS) {
    const v = out[key];
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) out[key] = d;
    }
  }
  return out;
}

export async function commitBatch(
  batchId: string,
  actorId: string,
): Promise<CommitBatchResult> {
  // Deterministic commit order so cross-root FK lookups via
  // `lookupLocalId` succeed on the first pass:
  //   account → contact → lead → opportunity
  // Within a tier, ordered by id for a stable run-to-run sequence so a
  // parent account commits before any child account that lists it as
  // `_parentaccountid_value`. A cross-root parent in a different batch
  // entirely stays null until `reconcileRunFks` sweeps it.
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
            WHEN 'lead' THEN 3
            WHEN 'opportunity' THEN 4
            ELSE 5
          END`,
      asc(importRecords.id),
    );

  // Atomic state transition guards against concurrent commits. Two
  // simultaneous commitBatchAction clicks both pass the action-level
  // `status === "committed"` gate (read outside any lock), then both
  // enter `commitBatch` and process the same `approved` records,
  // producing duplicate entity rows. Session-scoped pg_advisory_lock is
  // unreliable under Supavisor transaction-mode pooling, so instead we
  // flip `import_batches.status` from its review state to `committing`
  // via a conditional UPDATE: if zero rows changed, another run already
  // took the slot and we bounce with ConflictError. The terminal status
  // ('committed' or 'failed') is set at the end of the loop.
  const lockResult = await db
    .update(importBatches)
    .set({ status: "committing" })
    .where(
      and(
        eq(importBatches.id, batchId),
        inArray(importBatches.status, ["reviewing", "approved"]),
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
              // Forensic linkage: name the CRM row this staged root
              // wrote and whether it was an INSERT or an UPDATE, plus
              // the child activities/tasks that rode in with it (id +
              // type + source) so the full graph this commit produced is
              // reconstructible from audit_log alone (§12). The child
              // list is capped (childCount carries the true total) so a
              // pathological fan-out can't bloat a single audit row —
              // mirrors §12's aggregate-with-sample contract.
              crmEntityType: result.crmEntityType,
              crmEntityId: result.crmEntityId,
              operation: result.operation,
              childCount: result.childCount,
              children: result.children.slice(0, RECORD_COMMITTED_CHILDREN_CAP),
              childrenTruncated:
                result.children.length > RECORD_COMMITTED_CHILDREN_CAP,
              ...(result.before ? { before: result.before } : {}),
            },
          });
          // Emit FK_UNRESOLVED audit AFTER the per-record tx committed
          // successfully. Emitting inside the tx via the global `db`
          // connection (writeAudit doesn't accept a tx handle) would
          // leave orphan FK_UNRESOLVED rows if the tx rolled back.
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
                  "resolved automatically by the post-run reconcile sweep once the foreign record lands, or set manually via the edit form",
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
            after: { reason: result.reason },
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
        // Wrap the failure-state update so a transient DB error here
        // can't leave the record in `approved` state (which would cause
        // it to be re-processed and double-write on the next click). If
        // the row update itself fails we log a structured marker.
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
        // Pair the row's status='failed' update with a forensic audit
        // row. writeAudit is best-effort; an audit outage cannot block
        // the commit-batch loop's remaining work.
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

    // Reconcile the batch counters from the durable record statuses
    // rather than the in-memory loop tallies. Per-record commits each
    // persist `import_records.status` in their own tx; if a prior run
    // of this loop crashed AFTER committing records but BEFORE this
    // counter write, those records are skipped on retry (status !=
    // 'approved' guard) and would never be re-counted by an increment.
    // Deriving absolute counts via COUNT(*) GROUP BY status makes the
    // write idempotent — a retry reconciles to the true totals.
    const statusCounts = await db
      .select({
        status: importRecords.status,
        count: sql<number>`count(*)::int`,
      })
      .from(importRecords)
      .where(eq(importRecords.batchId, batchId))
      .groupBy(importRecords.status);
    const countFor = (status: string): number =>
      statusCounts.find((r) => r.status === status)?.count ?? 0;
    const committedTotal = countFor("committed");
    const failedTotal = countFor("failed");
    const skippedTotal = countFor("skipped");

    // Status reflects actual outcome. A batch with any failed record is
    // NOT 'committed' — it's 'failed', and the audit/admin UI surfaces
    // that so the operator investigates the failed rows instead of
    // treating the batch as a clean commit.
    await db
      .update(importBatches)
      .set({
        status: failedTotal > 0 ? "failed" : "committed",
        committedAt: new Date(),
        recordCountCommitted: committedTotal,
        recordCountFailed: failedTotal,
        recordCountSkipped: skippedTotal,
      })
      .where(eq(importBatches.id, batchId));

    return { committed, skipped, failed };
  } catch (err) {
    // If the loop crashes catastrophically (typecheck would catch most
    // paths but a runtime DB error could land here), put the batch back
    // into `reviewing` so a re-click can retry. Otherwise the batch
    // stays in `committing` forever and admin has to manually unstick
    // it. Per-record failures already wrote RECORD_COMMIT_FAILED rows.
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

/**
 * One committed child's forensic linkage: the local CRM row it wrote
 * (`crmEntityType` = `activity` | `task`, `crmEntityId` = that row's
 * UUID) and its D365 source (`sourceEntityType` / `sourceId`). Recorded
 * on the root's RECORD_COMMITTED audit `after.children` so a re-import or
 * an orphan investigation can reconstruct exactly which child rows a root
 * commit produced (§12 — meaningful mutations are auditable).
 */
interface CommittedChild {
  crmEntityType: "activity" | "task";
  crmEntityId: string;
  sourceEntityType: AttachedChild["sourceEntityType"];
  sourceId: string;
}

type CommitOneResult =
  | {
      outcome: "committed";
      unresolvedFks?: UnresolvedFk[];
      before?: { version?: number };
      // Forensic linkage: which CRM root row the staged record resolved
      // to, whether it was a fresh INSERT or an UPDATE, and the child
      // activities/tasks that were attached.
      crmEntityType: RootEntityType;
      crmEntityId: string;
      operation: "created" | "updated";
      childCount: number;
      children: CommittedChild[];
    }
  | {
      outcome: "skipped";
      reason: "dedup_skip";
    };

interface RecordRow {
  id: string;
  sourceEntityType: string;
  sourceId: string;
  mappedPayload: unknown;
  conflictResolution: string | null;
  conflictWith: string | null;
}

/**
 * One attached child as map-batch persisted it under
 * `mappedPayload.attached`. Mirrors `AttachedActivity` from
 * `./mapping`, but the JSONB round-trip means `payload`'s date fields
 * arrive as strings (re-hydrated below).
 */
interface AttachedChild {
  kind: "note" | "call" | "meeting" | "email" | "task";
  sourceId: string;
  sourceEntityType: "task" | "phonecall" | "appointment" | "email" | "annotation";
  payload: Record<string, unknown>;
}

function isRootEntityType(v: string): v is RootEntityType {
  return (
    v === "lead" || v === "contact" || v === "account" || v === "opportunity"
  );
}

async function commitOneRecord(
  rec: RecordRow,
  actorId: string,
): Promise<CommitOneResult> {
  if (!rec.mappedPayload || typeof rec.mappedPayload !== "object") {
    throw new ValidationError("missing mappedPayload", { recordId: rec.id });
  }
  const entityType = rec.sourceEntityType;
  if (!isRootEntityType(entityType)) {
    // The root-aggregate model only stages root records; a child type
    // here means the staged row predates the redesign or pull-batch
    // regressed. Fail loudly rather than mis-route into a parent table.
    throw new ValidationError(
      `import record is a child type (${entityType}); only root types commit in the aggregate model`,
      { recordId: rec.id, sourceEntityType: entityType },
    );
  }

  const wrapper = rec.mappedPayload as Record<string, unknown>;
  // map-batch persists mappedPayload as `{ mapped, attached, customFields }`.
  // The root insertable lives at `wrapper.mapped`; `wrapper.attached` is
  // the child-activity array; `customFields` is sibling metadata that
  // must NOT flow to Drizzle. Defensive fallback: if upstream wrote the
  // insertable directly at the top, we still unwrap correctly.
  const mappedRaw =
    wrapper.mapped && typeof wrapper.mapped === "object"
      ? (wrapper.mapped as Record<string, unknown>)
      : wrapper;

  const attached = parseAttachedChildren(wrapper.attached);

  // Cross-root FK source GUIDs stashed by the mappers as `_`-prefixed
  // virtuals, read BEFORE the strip.
  const accountSourceId = readVirtual(mappedRaw, "_accountSourceId");
  const parentAccountSourceId = readVirtual(
    mappedRaw,
    "_parentAccountSourceId",
  );
  const primaryContactSourceId = readVirtual(
    mappedRaw,
    "_primaryContactSourceId",
  );
  const sourceLeadSourceId = readVirtual(mappedRaw, "_sourceLeadSourceId");

  // Strip every `_`-prefixed virtual and re-hydrate date strings to
  // `Date` for the root payload before Drizzle insert.
  const cleanPayload = rehydrateDates(stripVirtuals(mappedRaw));

  return await db.transaction(async (tx): Promise<CommitOneResult> => {
    // Resolve cross-root FKs from D365 source GUIDs into already-imported
    // local rows. If the foreign record isn't imported yet the FK stays
    // null; the post-run reconcile sweep fills it once the parent lands.
    // The RECORD_FK_UNRESOLVED audit emission is DEFERRED to the outer
    // success branch so a tx rollback doesn't leave false-positive rows.
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
    if (entityType === "opportunity") {
      if (accountSourceId) {
        const localAccountId = await lookupLocalId(
          tx,
          "account",
          accountSourceId,
        );
        if (localAccountId) cleanPayload.accountId = localAccountId;
        else
          unresolvedFks.push({
            field: "accountId",
            sourceId: accountSourceId,
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
      if (sourceLeadSourceId) {
        const localLeadId = await lookupLocalId(tx, "lead", sourceLeadSourceId);
        if (localLeadId) cleanPayload.sourceLeadId = localLeadId;
        else
          unresolvedFks.push({
            field: "sourceLeadId",
            sourceId: sourceLeadSourceId,
            targetEntity: "lead",
          });
      }
    }

    // --- 1. Commit the ROOT entity -------------------------------------
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
      // The reviewer chose to skip this root entirely. Its children are
      // NOT committed — a child is never orphaned by a skip; the whole
      // root-aggregate is the unit of decision.
      await tx
        .update(importRecords)
        .set({
          status: "skipped",
          committedAt: new Date(),
        })
        .where(eq(importRecords.id, rec.id));
      return { outcome: "skipped", reason: "dedup_skip" };
    }

    const rootLocalId = parentResult.localId;

    // --- 2. Commit each attached child with the root's in-memory UUID --
    // No external_ids lookup for the parent FK — it is the UUID we just
    // captured, so it can never miss. Collect each child's local row id +
    // source linkage for the root's RECORD_COMMITTED audit `after`.
    const committedChildren: CommittedChild[] = [];
    for (const child of attached) {
      const childResult = await commitAttachedChild(
        tx,
        entityType,
        rootLocalId,
        child,
        actorId,
      );
      committedChildren.push({
        crmEntityType: child.sourceEntityType === "task" ? "task" : "activity",
        crmEntityId: childResult.localId,
        sourceEntityType: child.sourceEntityType,
        sourceId: child.sourceId,
      });
    }

    await tx
      .update(importRecords)
      .set({
        status: "committed",
        committedAt: new Date(),
        localId: rootLocalId,
      })
      .where(eq(importRecords.id, rec.id));

    return {
      outcome: "committed",
      unresolvedFks,
      crmEntityType: entityType,
      crmEntityId: rootLocalId,
      // `beforeVersion` is set only on the `conflictWith` UPDATE path;
      // its absence means the INSERT path ran — the created-vs-updated
      // signal.
      operation:
        parentResult.beforeVersion !== undefined ? "updated" : "created",
      childCount: attached.length,
      children: committedChildren,
      // capture pre-update version on the audit `before` payload so a
      // concurrent user edit's OCC interaction is reconstructible. The
      // D365 import is the documented authoritative writer for
      // D365-sourced records; the OCC `WHERE version = $expected` clause
      // is intentionally absent (overwrite means overwrite; merge uses
      // SQL-level COALESCE to preserve concurrent user writes).
      ...(parentResult.beforeVersion !== undefined
        ? { before: { version: parentResult.beforeVersion } }
        : {}),
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Attached-child parsing *
 * -------------------------------------------------------------------------- */

/**
 * Coerce the persisted `mappedPayload.attached` array into typed
 * `AttachedChild`s, dropping any malformed entry defensively. A child
 * with no usable `payload` object is skipped (logged by the caller's
 * failure path only if its insert later throws).
 */
function parseAttachedChildren(raw: unknown): AttachedChild[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachedChild[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    const sourceId = e.sourceId;
    const sourceEntityType = e.sourceEntityType;
    const payload = e.payload;
    if (
      typeof kind !== "string" ||
      typeof sourceId !== "string" ||
      typeof sourceEntityType !== "string" ||
      !payload ||
      typeof payload !== "object"
    ) {
      continue;
    }
    out.push({
      kind: kind as AttachedChild["kind"],
      sourceId,
      sourceEntityType: sourceEntityType as AttachedChild["sourceEntityType"],
      payload: payload as Record<string, unknown>,
    });
  }
  return out;
}

function readVirtual(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Drop every `_`-prefixed virtual; return a fresh object. */
function stripVirtuals(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Parent (root) entity commit *
 * -------------------------------------------------------------------------- */

type ParentCommitResult =
  | { outcome: "dedup_skip" }
  | { outcome: "committed"; localId: string; beforeVersion?: number };

async function commitParentEntity(
  tx: Tx,
  entityType: RootEntityType,
  sourceId: string,
  payload: Record<string, unknown>,
  conflictWith: string | null,
  conflictResolution: string | null,
  actorId: string,
): Promise<ParentCommitResult> {
  const table = PARENT_ENTITY_TABLES[entityType];

  // dedup_skip — don't touch the local row, but still link external_ids
  // so a re-import is idempotent.
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

    // Capture pre-update version (if the table tracks OCC) so the audit
    // `before` payload records the version the D365 import clobbered.
    const beforeVersion =
      typeof existingRow.version === "number"
        ? (existingRow.version as number)
        : undefined;

    if (Object.keys(update).length > 0) {
      const enriched: Record<string, unknown> = {
        ...update,
        updatedById: actorId,
        updatedAt: new Date(),
      };
      const versioned = table as unknown as { version?: unknown };
      if (versioned.version) {
        enriched.version = sql`${versioned.version as never} + 1`;
      }
      await tx.update(table).set(enriched).where(eq(table.id, conflictWith));
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
  entityType: RootEntityType,
  sourceId: string,
  payload: Record<string, unknown>,
  actorId: string,
): Promise<string> {
  const table = PARENT_ENTITY_TABLES[entityType];
  const clean: Record<string, unknown> = { ...payload };
  if (!clean.createdById) clean.createdById = actorId;
  if (!clean.updatedById) clean.updatedById = actorId;
  // The mapped payloads already match each table's NewX shape; the cast
  // keeps TS from demanding the union narrow at the call site.
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
 * mapped column overrides the local.
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
 * fields where the existing local value is null/undefined/empty string.
 *
 * Concurrent-write safety: the `existing` snapshot is read at the top of
 * `commitParentEntity`. Between that SELECT and the UPDATE a CRM user
 * can have edited the same row; a plain `SET col = $new` would clobber
 * that edit silently. The merge contract preserves user data, so each
 * value is wrapped in `COALESCE(<column>, $new)` — the DB decides at
 * UPDATE time whether the column is still empty; concurrent fills are
 * preserved. The JS-side `isEmpty` snapshot check stays to keep the
 * write-set minimal. STANDARDS §19.8 governs the idempotency contract.
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
    out[k] = sql`COALESCE(${col as never}, ${v})`;
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Attached-child commit *
 * -------------------------------------------------------------------------- */

/**
 * Insert one attached child under its root's freshly-captured local
 * UUID. Tasks land in the `tasks` table (dedup via external_ids since
 * `tasks` has no import-dedup column); every other kind lands in
 * `activities` with a per-parent `ON CONFLICT (<parentFk>,
 * import_dedup_key)` upsert. Each child gets its own `external_ids` row.
 *
 * The parent FK is the in-memory `rootLocalId` — never an external_ids
 * lookup — so it can never miss.
 */
async function commitAttachedChild(
  tx: Tx,
  parentEntityType: RootEntityType,
  rootLocalId: string,
  child: AttachedChild,
  actorId: string,
): Promise<{ localId: string }> {
  const fkColumn = PARENT_FK_COLUMN[parentEntityType];
  // Re-hydrate the child's date strings (createdAt/updatedAt/dueAt/
  // completedAt/occurredAt) back to `Date`, then strip any `_`-prefixed
  // virtuals (`_parentEntityType` / `_parentSourceId`) before insert.
  const childPayload = rehydrateDates(stripVirtuals(child.payload));

  if (child.sourceEntityType === "task") {
    return commitTaskChild(
      tx,
      fkColumn,
      rootLocalId,
      child.sourceId,
      childPayload,
      actorId,
    );
  }

  return commitActivityChild(
    tx,
    parentEntityType,
    fkColumn,
    rootLocalId,
    child,
    childPayload,
    actorId,
  );
}

/**
 * Task child → `tasks` table. `tasks` has no import-dedup column, so
 * idempotency rides on `external_ids` (source='d365',
 * sourceEntityType='task', sourceId=activityid): if the activity is
 * already mapped, skip the insert and keep the existing row.
 *
 * Race tolerance: the SELECT-then-INSERT can lose the race under READ
 * COMMITTED — two overlapping txns could both miss the SELECT and both
 * INSERT, then the `external_ids` upsert collides. The collision is
 * absorbed by `upsertExternalId`'s `ON CONFLICT DO UPDATE` (the second
 * writer wins idempotently) rather than throwing a unique violation that
 * would abort the surrounding transaction — so we do NOT catch here (a
 * catch around an aborted Postgres transaction can't recover without a
 * SAVEPOINT, and the upsert means there is no violation to catch). The
 * narrow residual — a duplicate `tasks` ROW from the lost race — would
 * need a unique constraint on `tasks` to fully prevent (a migration,
 * out of scope here); in practice batch commits are serialized by the
 * `import_batches` status lock, so two commits of the same task don't
 * overlap.
 *
 * Returns the local `tasks.id` for the committed/existing row.
 */
async function commitTaskChild(
  tx: Tx,
  fkColumn: "leadId" | "accountId" | "contactId" | "opportunityId",
  rootLocalId: string,
  sourceId: string,
  payload: Record<string, unknown>,
  actorId: string,
): Promise<{ localId: string }> {
  const existing = await tx
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, "d365"),
        eq(externalIds.sourceEntityType, "task"),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    // Already imported — keep the mapping fresh, do not duplicate.
    await upsertExternalId(tx, "task", sourceId, existing[0].localId);
    return { localId: existing[0].localId };
  }

  const insertValues: Record<string, unknown> = {
    ...payload,
    // Pin the parent FK to the root's in-memory UUID; null the other
    // three so the tasks at-most-one-parent CHECK holds.
    leadId: null,
    accountId: null,
    contactId: null,
    opportunityId: null,
    [fkColumn]: rootLocalId,
  };
  if (!insertValues.assignedToId) insertValues.assignedToId = actorId;
  if (!insertValues.createdById) insertValues.createdById = actorId;
  if (!insertValues.updatedById) insertValues.updatedById = actorId;

  const inserted = await tx
    .insert(tasks)
    .values(insertValues as typeof tasks.$inferInsert)
    .returning({ id: tasks.id });
  const row = inserted[0];
  if (!row) {
    throw new ConflictError("task insert returned no row", { sourceId });
  }
  await upsertExternalId(tx, "task", sourceId, row.id);
  return { localId: row.id };
}

/**
 * Activity child (note / call / meeting / email) → `activities` table.
 * Idempotent via the per-parent partial UNIQUE arbiter
 * `(<parentFk>, import_dedup_key) WHERE import_dedup_key IS NOT NULL`
 * (added by the dedup-generalize migration). The mappers always set a
 * non-null `importDedupKey` (`d365-<source>:<activityid>`), so the
 * arbiter is active; on conflict we preserve the row's D365-sourced
 * recency (`updatedAt` = source `modifiedon`) rather than stamping the
 * wall-clock import time, then re-point its external_ids mapping. The
 * sync time is recorded separately on `external_ids.importedAt` /
 * `lastSyncedAt`, so overwriting `updatedAt` with `now()` would corrupt
 * the activity's D365 recency on every re-import.
 */
async function commitActivityChild(
  tx: Tx,
  parentEntityType: RootEntityType,
  fkColumn: "leadId" | "accountId" | "contactId" | "opportunityId",
  rootLocalId: string,
  child: AttachedChild,
  payload: Record<string, unknown>,
  actorId: string,
): Promise<{ localId: string }> {
  const kind = ACTIVITY_KIND[child.sourceEntityType];
  if (!kind) {
    throw new ValidationError(
      `unknown activity child source type: ${child.sourceEntityType}`,
      { sourceId: child.sourceId },
    );
  }

  // occurredAt is NOT NULL on activities; the mappers always emit it
  // (re-hydrated above), but fall back to now() defensively rather than
  // crashing the whole root graph on a single malformed child.
  const occurredAt =
    payload.occurredAt instanceof Date ? payload.occurredAt : new Date();

  const importDedupKey =
    typeof payload.importDedupKey === "string" ? payload.importDedupKey : null;

  // D365-sourced recency for the conflict-path SET. `updatedAt` rides
  // through the mapped payload as the source `modifiedon` (rehydrated to
  // a Date above); preserve it on re-import instead of stamping the
  // wall-clock import time. Fall back to occurredAt only if it is
  // somehow absent so the column never goes null.
  const sourceUpdatedAt =
    payload.updatedAt instanceof Date ? payload.updatedAt : occurredAt;

  const insertValues = {
    ...(payload as Partial<typeof activities.$inferInsert>),
    kind,
    leadId: null,
    accountId: null,
    contactId: null,
    opportunityId: null,
    [fkColumn]: rootLocalId,
    occurredAt,
    // FRESH insert only: stamp the import actor so realtime skip-self
    // works. On the CONFLICT path (a re-import) the `set` below writes
    // only updatedAt (= source modifiedon) and leaves updatedById on the
    // existing row untouched.
    updatedById: actorId,
  } as typeof activities.$inferInsert;

  const parentFkCol = activities[fkColumn];

  // The arbiter's `targetWhere` MUST match the partial-index predicate
  // exactly or Postgres rejects the upsert with 42P10. The legacy
  // lead-parent index (`activities_import_dedup_idx`, migration 0020) is
  // partial ONLY on `import_dedup_key IS NOT NULL`; the generalized
  // account/contact/opportunity indexes add `AND <fk> IS NOT NULL`.
  const targetWhere =
    parentEntityType === "lead"
      ? sql`import_dedup_key is not null`
      : parentEntityType === "account"
        ? sql`import_dedup_key is not null and account_id is not null`
        : parentEntityType === "contact"
          ? sql`import_dedup_key is not null and contact_id is not null`
          : sql`import_dedup_key is not null and opportunity_id is not null`;

  const inserted = await tx
    .insert(activities)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [parentFkCol, activities.importDedupKey],
      targetWhere,
      set: {
        // Preserve D365-sourced recency on re-import — set updatedAt from
        // the incoming payload's source `modifiedon`, NOT the wall-clock
        // import time. Stamping now() here corrupted the activity's D365
        // recency on every sync. The sync time is recorded separately on
        // external_ids (lastSyncedAt / importedAt). updatedById is left
        // as the existing row's value (not overwritten with the import
        // actor). The dedup key + parent stay put.
        updatedAt: sourceUpdatedAt,
      },
    })
    .returning({ id: activities.id });

  let row = inserted[0];
  if (!row) {
    // ON CONFLICT can return zero rows when the arbiter's predicate
    // (`import_dedup_key IS NOT NULL`) excludes the row — i.e. the
    // mapper produced a null dedup key. Recover the existing row by
    // (parentFk, dedup key) so the external_ids mapping still points at
    // it; if there genuinely is none, this is a hard failure.
    if (importDedupKey != null) {
      const dup = await tx
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            eq(parentFkCol, rootLocalId),
            eq(activities.importDedupKey, importDedupKey),
          ),
        )
        .limit(1);
      row = dup[0];
    }
    if (!row) {
      throw new ConflictError("activity insert returned no row", {
        sourceEntityType: child.sourceEntityType,
        sourceId: child.sourceId,
        parentEntityType,
      });
    }
  }

  await upsertExternalId(tx, child.sourceEntityType, child.sourceId, row.id);
  return { localId: row.id };
}

/* -------------------------------------------------------------------------- *
 * external_ids lookup + upsert *
 * -------------------------------------------------------------------------- */

/**
 * Resolve a D365 GUID for a related record to the local UUID via the
 * external_ids table. Returns null when the foreign record hasn't been
 * imported yet — callers leave the FK null (the reconcile sweep fills it).
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
  entityType: RootEntityType | "task" | "phonecall" | "appointment" | "email" | "annotation",
  sourceId: string,
  localId: string,
): Promise<void> {
  // Local entity type the external_ids row points at: roots map to
  // themselves; D365 `task` lands in the `tasks` table (localEntityType
  // 'task'); every other child activity lands in `activities`.
  const localEntityType =
    entityType === "task"
      ? "task"
      : entityType === "phonecall" ||
          entityType === "appointment" ||
          entityType === "email" ||
          entityType === "annotation"
        ? "activity"
        : entityType;

  // Atomic upsert against `extid_source_sourceid_idx`. The prior
  // check-then-insert lost the race under READ COMMITTED — two
  // concurrent runs could both miss the SELECT and both INSERT, throwing
  // a unique violation. ON CONFLICT DO UPDATE makes the second writer
  // win idempotently while refreshing localId + lastSyncedAt.
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

/* -------------------------------------------------------------------------- *
 * Post-run cross-root FK reconcile sweep *
 * -------------------------------------------------------------------------- */

export interface ReconcileRunFksResult {
  /** Local entity rows with ≥1 still-null cross-root FK that were scanned. */
  scanned: number;
  /** Rows that had ≥1 FK resolved + updated by this sweep. */
  resolved: number;
  /** Individual FK fields still unresolved (parent not yet imported). */
  stillUnresolved: number;
  /**
   * Rows with a NULL cross-root FK but no D365 provenance to resolve
   * from (no staged rawPayload). Left untouched.
   */
  noSourceProvenance: number;
}

const RECONCILE_PAGE = 200;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Re-resolve any still-null cross-root FK on the entities a run
 * committed, from their retained `import_records.rawPayload`, after the
 * whole run finishes. Replaces the manual opportunity-FK backfill
 * button: the same quarantine-then-reconcile pattern, but generalized to
 * every cross-root edge (opportunity→account/contact/originatingLead;
 * contact→account; account→parentAccount/primaryContact) and scoped to
 * the records of one run.
 *
 * Idempotent: only fills a column that is currently NULL, only when
 * resolution succeeds. Safe to re-run after a later root import lands.
 *
 * Children FKs never need reconciling — they are pinned to the root's
 * in-memory UUID at commit time and cannot miss. This sweep is for the
 * cross-ROOT edges only, where a parent root may live in a later batch.
 */
export async function reconcileRunFks(
  runId: string,
  actorId: string,
): Promise<ReconcileRunFksResult> {
  const result: ReconcileRunFksResult = {
    scanned: 0,
    resolved: 0,
    stillUnresolved: 0,
    noSourceProvenance: 0,
  };

  // The records this run committed, with their retained raw payloads, in
  // dependency order so a still-null edge has the best chance of
  // resolving in a single pass (account → contact → opportunity; leads
  // have no cross-root parent edge to reconcile here).
  let offset = 0;
  for (;;) {
    const page = await db
      .select({
        sourceEntityType: importRecords.sourceEntityType,
        localId: importRecords.localId,
        rawPayload: importRecords.rawPayload,
      })
      .from(importRecords)
      .innerJoin(importBatches, eq(importBatches.id, importRecords.batchId))
      .where(
        and(
          eq(importBatches.runId, runId),
          eq(importRecords.status, "committed"),
          inArray(importRecords.sourceEntityType, [
            "contact",
            "account",
            "opportunity",
          ]),
        ),
      )
      .orderBy(
        sql`CASE ${importRecords.sourceEntityType}
              WHEN 'account' THEN 1
              WHEN 'contact' THEN 2
              WHEN 'opportunity' THEN 3
              ELSE 4
            END`,
        asc(importRecords.id),
      )
      .limit(RECONCILE_PAGE)
      .offset(offset);

    if (page.length === 0) break;

    for (const row of page) {
      if (!row.localId) continue;
      const raw =
        row.rawPayload && typeof row.rawPayload === "object"
          ? extractRootRaw(row.rawPayload as Record<string, unknown>)
          : null;
      if (!raw) {
        result.noSourceProvenance += 1;
        continue;
      }

      const resolvedAny = await reconcileOneRow(
        row.sourceEntityType as "contact" | "account" | "opportunity",
        row.localId,
        raw,
        actorId,
        result,
        runId,
      );
      result.scanned += 1;
      if (resolvedAny) result.resolved += 1;
    }

    if (page.length < RECONCILE_PAGE) break;
    offset += RECONCILE_PAGE;
  }

  logger.info("d365.reconcile.run_fks.summary", {
    runId,
    actorId,
    scanned: result.scanned,
    resolved: result.resolved,
    stillUnresolved: result.stillUnresolved,
    noSourceProvenance: result.noSourceProvenance,
  });

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.BACKFILL_OPPORTUNITY_FK,
    targetType: "import_run",
    targetId: runId,
    after: {
      scanned: result.scanned,
      resolved: result.resolved,
      stillUnresolved: result.stillUnresolved,
      noSourceProvenance: result.noSourceProvenance,
      scope: "run_reconcile_sweep",
    },
  });

  return result;
}

/**
 * Unwrap the root raw record from the persisted root-aggregate payload
 * (`{ root, children, _sourceOwnerId }`). Falls back to the object
 * itself for any legacy flat payload.
 */
function extractRootRaw(
  rawPayload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (rawPayload.root && typeof rawPayload.root === "object") {
    return rawPayload.root as Record<string, unknown>;
  }
  // Legacy flat shape.
  return rawPayload;
}

/**
 * Reconcile a single committed row's cross-root FKs. Only NULL columns
 * are touched. Returns true if ≥1 FK was resolved + written.
 *
 * Each table is handled with a concrete `db.update(<table>)` call (not a
 * union-typed helper) because Drizzle's builder methods don't narrow
 * cleanly over a union of table types. The shared logic — "resolve the
 * foreign GUID or emit an unresolved-FK audit row" — lives in
 * `resolveForeignFk`; the concrete UPDATE stays per-table.
 */
async function reconcileOneRow(
  entityType: "contact" | "account" | "opportunity",
  localId: string,
  raw: Record<string, unknown>,
  actorId: string,
  result: ReconcileRunFksResult,
  runId: string,
): Promise<boolean> {
  if (entityType === "contact") {
    const accountSourceId =
      str(raw._parentcustomerid_value) ?? str(raw._accountid_value);
    if (!accountSourceId) return false;
    const id = await resolveForeignFk(
      "accountId",
      "account",
      accountSourceId,
      localId,
      actorId,
      result,
      runId,
    );
    if (!id) return false;
    await db
      .update(contacts)
      .set({ accountId: id })
      .where(and(eq(contacts.id, localId), isNull(contacts.accountId)));
    return true;
  }

  if (entityType === "account") {
    let any = false;
    const parentAccountSourceId = str(raw._parentaccountid_value);
    if (parentAccountSourceId) {
      const id = await resolveForeignFk(
        "parentAccountId",
        "account",
        parentAccountSourceId,
        localId,
        actorId,
        result,
        runId,
      );
      if (id) {
        await db
          .update(crmAccounts)
          .set({ parentAccountId: id })
          .where(
            and(eq(crmAccounts.id, localId), isNull(crmAccounts.parentAccountId)),
          );
        any = true;
      }
    }
    const primaryContactSourceId = str(raw._primarycontactid_value);
    if (primaryContactSourceId) {
      const id = await resolveForeignFk(
        "primaryContactId",
        "contact",
        primaryContactSourceId,
        localId,
        actorId,
        result,
        runId,
      );
      if (id) {
        await db
          .update(crmAccounts)
          .set({ primaryContactId: id })
          .where(
            and(
              eq(crmAccounts.id, localId),
              isNull(crmAccounts.primaryContactId),
            ),
          );
        any = true;
      }
    }
    return any;
  }

  // opportunity
  let any = false;
  const customerSourceId = str(raw._customerid_value);
  const accountSourceId = str(raw._parentaccountid_value) ?? customerSourceId;
  if (accountSourceId) {
    const id = await resolveForeignFk(
      "accountId",
      "account",
      accountSourceId,
      localId,
      actorId,
      result,
      runId,
    );
    if (id) {
      await db
        .update(opportunities)
        .set({ accountId: id })
        .where(
          and(eq(opportunities.id, localId), isNull(opportunities.accountId)),
        );
      any = true;
    }
  }
  const primaryContactSourceId =
    str(raw._parentcontactid_value) ?? customerSourceId;
  if (primaryContactSourceId) {
    const id = await resolveForeignFk(
      "primaryContactId",
      "contact",
      primaryContactSourceId,
      localId,
      actorId,
      result,
      runId,
    );
    if (id) {
      await db
        .update(opportunities)
        .set({ primaryContactId: id })
        .where(
          and(
            eq(opportunities.id, localId),
            isNull(opportunities.primaryContactId),
          ),
        );
      any = true;
    }
  }
  const sourceLeadSourceId = str(raw._originatingleadid_value);
  if (sourceLeadSourceId) {
    const id = await resolveForeignFk(
      "sourceLeadId",
      "lead",
      sourceLeadSourceId,
      localId,
      actorId,
      result,
      runId,
    );
    if (id) {
      await db
        .update(opportunities)
        .set({ sourceLeadId: id })
        .where(
          and(eq(opportunities.id, localId), isNull(opportunities.sourceLeadId)),
        );
      any = true;
    }
  }
  return any;
}

/**
 * Resolve a foreign D365 GUID to its local UUID via external_ids.
 * Returns the local id when found; on a miss, increments
 * `stillUnresolved`, emits a forensic RECORD_FK_UNRESOLVED audit row,
 * and returns null. The caller does the concrete (currently-NULL-guarded)
 * UPDATE only when a local id comes back.
 *
 * Audit target pair is consistent: `targetType='import_run'` +
 * `targetId=runId` (the sweep is run-scoped); the specific CRM row that
 * still has the null FK rides in the detail body (`localEntityId`) so the
 * (type, id) pair always agrees. Previously this used
 * `targetType='import_run'` with `targetId` set to a CRM entity row id —
 * a mismatch that broke target_type/target_id audit filtering.
 */
async function resolveForeignFk(
  fieldName: string,
  foreignEntity: "account" | "contact" | "lead",
  foreignSourceId: string,
  localId: string,
  actorId: string,
  result: ReconcileRunFksResult,
  runId: string,
): Promise<string | null> {
  const foreignLocalId = await lookupLocalId(db, foreignEntity, foreignSourceId);
  if (foreignLocalId) return foreignLocalId;

  result.stillUnresolved += 1;
  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.RECORD_FK_UNRESOLVED,
    targetType: "import_run",
    targetId: runId,
    after: {
      // The local CRM row that still has the null FK (moved into the body
      // so the targetType/targetId pair stays consistent).
      localEntityId: localId,
      field: fieldName,
      foreignEntity,
      foreignSourceId,
      viaReconcile: true,
      remediation:
        "re-run the import (or the reconcile sweep) after the parent record lands",
    },
  });
  return null;
}
