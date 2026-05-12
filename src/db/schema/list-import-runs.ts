import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { marketingLists } from "./marketing-lists";
import { users } from "./users";

/**
 * Status for static-list Excel/CSV imports. Mirrors the
 * existing `import_status` enum in `imports.ts` but kept distinct so
 * the leads-import lifecycle and the static-list-import lifecycle can
 * evolve independently.
 */
export const listImportRunStatusEnum = pgEnum("list_import_run_status", [
  // Created but the preview has not been built (transient state).
  "pending",
  // Workbook parsed; preview shown; user has not committed yet.
  "previewing",
  // User clicked Commit; rows are being inserted.
  "committing",
  // All rows inserted successfully.
  "success",
  // Some rows failed to insert.
  "partial_failure",
  // User dismissed the preview without committing.
  "cancelled",
]);

/**
 * Static-list Excel import worklog.
 *
 * Mirrors `import_jobs` columns but FK'd to a specific
 * `marketing_lists` row so a list can have multiple imports over time
 * and an in-progress run can be resumed by the originating user.
 *
 * `errors` JSONB shape (per failed / flagged row):
 * { row: number, field: 'email'|'name'|null, code: string, message: string }
 *
 * `parsed_rows` JSONB shape (persisted at preview-time so commit does
 * NOT re-parse the workbook):
 * { row: number, email: string, name: string|null, status: 'ok'|'skip'|'invalid', reason?: string }[]
 */
export const listImportRuns = pgTable(
  "list_import_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    listId: uuid("list_id")
      .notNull()
      .references(() => marketingLists.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    successfulRows: integer("successful_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    needsReviewRows: integer("needs_review_rows").notNull().default(0),
    /**
     * Per-row validation errors. See the JSDoc above for shape.
     */
    errors: jsonb("errors"),
    /**
     * Parsed-row snapshot. Persisted at preview-time so commit doesn't
     * re-parse. Cleared at commit-time to keep the row small.
     */
    parsedRows: jsonb("parsed_rows"),
    status: listImportRunStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Resume-an-import lookup: "is there an in-flight run for this list
    // owned by me?" — list_id + user_id + status. Drizzle indexes do
    // not support partial predicates on a non-column expression yet,
    // so the WHERE-status filter lives in the application query.
    index("list_import_runs_list_user_idx").on(t.listId, t.userId),
    index("list_import_runs_status_idx").on(t.status),
    // Covering index for the user_id FK (avoids
    // `unindexed_foreign_keys` Supabase advisory).
    index("list_import_runs_user_id_idx").on(t.userId),
  ],
);

export type ListImportRunStatus =
  (typeof listImportRunStatusEnum.enumValues)[number];
