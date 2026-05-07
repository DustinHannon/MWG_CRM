import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { importStatusEnum } from "./enums";
import { users } from "./users";

export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  totalRows: integer("total_rows").notNull().default(0),
  successfulRows: integer("successful_rows").notNull().default(0),
  failedRows: integer("failed_rows").notNull().default(0),
  needsReviewRows: integer("needs_review_rows").notNull().default(0),
  // Array of { row, field, message } for failed rows.
  errors: jsonb("errors"),
  status: importStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
