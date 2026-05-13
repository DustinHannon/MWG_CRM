import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * D365 import pipeline state.
 *
 * Four tables:
 * external_ids — universal source-id linkage for any imported entity.
 * import_runs — one user-initiated import session per (entity, scope).
 * import_batches — fixed-size review units (D365_IMPORT_BATCH_SIZE = 100).
 * import_records — per-row review state with raw + mapped payloads.
 *
 * Designed for human-in-the-loop review. Run halts on D365 outage,
 * unmapped picklist, high-volume conflict, owner-JIT failure, or
 * validation regression — see §4.5 of the brief.
 *
 * Recency preservation rule (§5.2): commit code populates the
 * downstream entity's created_at / updated_at from the D365 source's
 * createdon / modifiedon — NOT from import time. The `imported_at`
 * column on `external_ids` separately captures when the import ran.
 */

/**
 * external_ids — universal cross-system linkage.
 *
 * One row per (source, sourceEntityType, sourceId). Re-imports are
 * idempotent: dedup by external_id first, then update in place.
 *
 * Today the only `source` is `'d365'`. The column is text for forward
 * compatibility with future ClickDimensions, HubSpot, etc. imports.
 */
export const externalIds = pgTable(
  "external_ids",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceId: text("source_id").notNull(),
    localEntityType: text("local_entity_type").notNull(),
    localId: uuid("local_id").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // Optional payload digest, e.g. `{ "hash": "<sha256>", "version": 1 }`,
    // used to detect upstream changes without storing the full payload.
    metadata: jsonb("metadata"),
  },
  (t) => [
    uniqueIndex("extid_source_sourceid_idx").on(
      t.source,
      t.sourceEntityType,
      t.sourceId,
    ),
    index("extid_local_idx").on(t.localEntityType, t.localId),
  ],
);

/**
 * import_runs — one row per user-initiated import session.
 *
 * `status` lifecycle:
 * created → fetching → mapping → reviewing → committing → completed
 * ↘ paused_for_review (halt condition fired)
 * ↘ aborted (admin abort)
 *
 * `scope` JSONB shape:
 * { filter?: { modifiedSince?: ISO8601, statecode?: number[] },
 * fields?: string[],
 * expand?: string[],
 * includeChildren?: boolean }
 *
 * `cursor` holds the OData @odata.nextLink (or skiptoken) for the
 * next page within the entity. Persisted so a run can resume across
 * sessions / devices.
 *
 * `notes` accumulates halt reasons and resolutions as JSON-encoded
 * appended log entries (one per line).
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    entityType: text("entity_type").notNull(),
    status: text("status", {
      enum: [
        "created",
        "fetching",
        "mapping",
        "reviewing",
        "committing",
        "paused_for_review",
        "completed",
        "aborted",
      ],
    })
      .notNull()
      .default("created"),
    scope: jsonb("scope").notNull(),
    cursor: text("cursor"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("imprun_status_idx").on(t.status),
    index("imprun_entity_idx").on(t.entityType),
    index("imprun_created_idx").on(t.createdAt.desc()),
  ],
);

/**
 * import_batches — fixed-size review units within a run.
 *
 * Batch size is locked at D365_IMPORT_BATCH_SIZE=100 by the brief.
 * `batchNumber` is monotonic per-run, starting at 1.
 *
 * `status` lifecycle:
 * pending → fetched → reviewing → approved/rejected → committed/failed
 *
 * Counts sum to recordCountFetched at every state transition.
 */
export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),
    batchNumber: integer("batch_number").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "fetched",
        "reviewing",
        "approved",
        "rejected",
        // Transient lock state set by commit-batch at the start of its
        // loop and flipped to `committed` or `failed` at the end. If a
        // batch is found in `committing` state after a Vercel function
        // crash, the next commit attempt fails the action-layer
        // status gate; admin must manually reset to `reviewing` /
        // `approved` after inspection (rare path; explicit so it can't
        // be missed).
        "committing",
        "committed",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    recordCountFetched: integer("record_count_fetched").notNull().default(0),
    recordCountApproved: integer("record_count_approved").notNull().default(0),
    recordCountRejected: integer("record_count_rejected").notNull().default(0),
    recordCountCommitted: integer("record_count_committed").notNull().default(0),
    recordCountConflicts: integer("record_count_conflicts").notNull().default(0),
    recordCountFailed: integer("record_count_failed").notNull().default(0),
    // commit-batch increments this on every record that returns
    // `outcome: "skipped"` (dedup_skip from the reviewer, bad-lead
    // quality auto-skip from map-batch, or missing-parent activity
    // skip from commit-batch). Prior to this column the skipped count
    // was returned to the action caller but silently dropped from the
    // batch row — operators saw committed + failed only.
    recordCountSkipped: integer("record_count_skipped").notNull().default(0),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("impbat_run_num_idx").on(t.runId, t.batchNumber),
    index("impbat_status_idx").on(t.status),
  ],
);

/**
 * import_records — per-row state during review and commit.
 *
 * `rawPayload` is the literal D365 OData object as returned —
 * preserved verbatim for forensic / re-replay use.
 *
 * `mappedPayload` is what the entity-specific mapper produced and
 * what gets inserted into the local entity tables on commit. May be
 * edited by the reviewer in the admin UI; final shape at commit time
 * is what lands.
 *
 * `validationWarnings` is an array of `{ field, code, message }`
 * surfaced inline in the review UI but does not block commit.
 *
 * Conflict resolution (`dedup_*`) is set by Sub-agent B's mapper
 * during dedup; reviewer can override per record.
 *
 * `localId` is populated only after commit — it's the FK into the
 * downstream entity table (leads.id, contacts.id, etc.).
 */
export const importRecords = pgTable(
  "import_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceId: text("source_id").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    mappedPayload: jsonb("mapped_payload"),
    validationWarnings: jsonb("validation_warnings"),
    conflictResolution: text("conflict_resolution", {
      enum: [
        "none",
        "dedup_skip",
        "dedup_merge",
        "dedup_overwrite",
        "manual_resolved",
      ],
    }),
    // Local-entity UUID this record duplicates, when dedup matched.
    conflictWith: uuid("conflict_with"),
    status: text("status", {
      enum: [
        "pending",
        "mapped",
        "review",
        "approved",
        "rejected",
        "committed",
        "skipped",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    reviewerId: uuid("reviewer_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    localId: uuid("local_id"),
    // Free-form failure detail when status='failed'.
    error: text("error"),
  },
  (t) => [
    index("imprec_batch_idx").on(t.batchId),
    index("imprec_status_idx").on(t.status),
    index("imprec_source_idx").on(t.sourceEntityType, t.sourceId),
    index("imprec_conflict_idx").on(t.conflictWith),
  ],
);
