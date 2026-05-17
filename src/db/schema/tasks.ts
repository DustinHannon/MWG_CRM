import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts, crmAccounts, opportunities } from "./crm-records";
import { leads } from "./leads";
import { users } from "./users";

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "in_progress",
  "completed",
  "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

/**
 * tasks. Distinct from `activities` (records of what
 * happened): tasks are things to DO with a due date.
 *
 * extends with account_id/contact_id/opportunity_id and adds
 * a CHECK constraint enforcing at-most-one parent.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => crmAccounts.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    // Stored as TIMESTAMPTZ for historical reasons. UI surfaces all
    // treat dueAt as date-only: inputs use <input type="date"> and
    // normalize to local-midnight at submit time
    // (`new Date("YYYY-MM-DDT00:00:00")`), displays use
    // `formatUserTime(value, prefs, "date")` which renders in the
    // user's configured timezone (default America/Chicago).
    // Maintaining the local-midnight convention ensures the stored
    // instant resolves to the same calendar day across all viewers
    // who share the same TZ preference.
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    assignedToId: uuid("assigned_to_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // actor stamp for realtime skip-self.
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
  },
  (t) => [
    index("tasks_assigned_due_idx").on(t.assignedToId, t.dueAt),
    index("tasks_lead_idx").on(t.leadId, t.status, t.dueAt),
    // composite cursor pagination key for /tasks
    // (assigned_to_id, due_at NULLS LAST, id DESC). Partial on
    // is_deleted=false because the list page never shows archived rows.
    index("tasks_assigned_due_at_id_idx")
      .on(t.assignedToId, sql`due_at ASC NULLS LAST`, t.id.desc())
      .where(sql`is_deleted = false`),
  ],
);

/**
 * In-app bell notifications. Persisted; user marks read with the bell
 * popover or the /notifications page.
 *
 * Kind values: 'task_assigned' | 'task_due' | 'mention' | 'saved_search'.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    isRead: boolean("is_read").notNull().default(false),
    // Structured activity-log fields (kind = 'activity'). All
    // nullable so pre-existing rows and the other kinds
    // (task_assigned, mailbox_blocked, …) are unaffected — no
    // backfill. actorId = the user whose action this records; in
    // the actor's-own-activity model actorId === userId (recipient).
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    verb: text("verb"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    entityDisplayName: text("entity_display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("notifications_user_unread_idx").on(
      t.userId,
      t.isRead,
      t.createdAt.desc(),
    ),
    // activity-log keyset (user's own feed, newest first) + the
    // badge "created_at > last_seen" count.
    index("notifications_user_created_idx").on(
      t.userId,
      t.createdAt.desc(),
    ),
  ],
);
