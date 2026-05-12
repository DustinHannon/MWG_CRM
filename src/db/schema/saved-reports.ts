import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * saved_reports.
 *
 * Reports are shared at the *definition* level: an admin can create a
 * report and toggle is_shared=true, but the rows the report returns are
 * always scoped to the **viewer**, not the author. See
 * `src/lib/reports/access.ts` (executeReport) for the enforcement.
 *
 * is_builtin reports are inserted by scripts/seed-builtin-reports.ts.
 * The owner_id of builtin reports is the system service user. Builtin
 * reports cannot be deleted by anyone (server action enforces).
 */
export const savedReports = pgTable(
  "saved_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    entityType: text("entity_type").notNull(),
    fields: text("fields").array().notNull().default(sql`'{}'::text[]`),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    groupBy: text("group_by").array().notNull().default(sql`'{}'::text[]`),
    metrics: jsonb("metrics").notNull().default(sql`'[]'::jsonb`),
    visualization: text("visualization").notNull().default("table"),
    isShared: boolean("is_shared").notNull().default(false),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("saved_reports_owner_active_idx")
      .on(t.ownerId, t.updatedAt.desc())
      .where(sql`is_deleted = false`),
    index("saved_reports_shared_active_idx")
      .on(t.isShared, t.updatedAt.desc())
      .where(sql`is_deleted = false AND is_shared = true`),
    index("saved_reports_builtin_idx")
      .on(t.name)
      .where(sql`is_builtin = true AND is_deleted = false`),
    index("saved_reports_deleted_by_id_idx")
      .on(t.deletedById)
      .where(sql`deleted_by_id IS NOT NULL`),
  ],
);

export type SavedReport = typeof savedReports.$inferSelect;
export type SavedReportInsert = typeof savedReports.$inferInsert;

export const REPORT_ENTITY_TYPES = [
  "lead",
  "account",
  "contact",
  "opportunity",
  "activity",
  "task",
  // + marketing/email entities. Visible to admins +
  // users with canManageMarketing only — see access.ts assertCanViewReport.
  "marketing_campaign",
  "marketing_email_event",
  "email_send_log",
] as const;
export type ReportEntityType = (typeof REPORT_ENTITY_TYPES)[number];

/** Entity types that should only be visible to admins / canManageMarketing. */
export const MARKETING_REPORT_ENTITY_TYPES: readonly ReportEntityType[] = [
  "marketing_campaign",
  "marketing_email_event",
  "email_send_log",
] as const;

export const REPORT_VISUALIZATIONS = [
  "table",
  "bar",
  "line",
  "pie",
  "kpi",
  "funnel",
] as const;
export type ReportVisualization = (typeof REPORT_VISUALIZATIONS)[number];

export const REPORT_METRIC_FUNCTIONS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
] as const;
export type ReportMetricFunction = (typeof REPORT_METRIC_FUNCTIONS)[number];

export interface ReportMetric {
  fn: ReportMetricFunction;
  field?: string;
  alias: string;
}
