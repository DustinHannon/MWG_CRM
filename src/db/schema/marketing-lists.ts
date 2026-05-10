import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { users } from "./users";

/**
 * Phase 19 — Marketing list (segment of recipients).
 *
 * A list is defined by a JSONB filter (`filter_dsl`) that is evaluated
 * against the `leads` table. We snapshot membership into
 * `marketing_list_members` whenever the list is refreshed (manual,
 * pre-campaign-send, or daily cron), denormalizing the recipient email so
 * suppression-filtering on send doesn't have to JOIN back to leads.
 *
 * Soft-delete preserves the list rule for audit even after a marketing
 * user "deletes" it.
 */
export const marketingLists = pgTable(
  "marketing_lists",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Phase 14 cross-entity filter DSL serialized as JSON. Shape:
     *   { combinator: "AND" | "OR", rules: Array<{ field, op, value }> }
     * Evaluated server-side via @/lib/marketing/lists/refresh against the
     * leads table. We do NOT trust unknown fields/ops — the refresh helper
     * whitelists.
     */
    filterDsl: jsonb("filter_dsl").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("mkt_list_status_idx")
      .on(t.isDeleted, t.updatedAt.desc())
      .where(sql`is_deleted = false`),
    index("mkt_list_created_by_idx").on(t.createdById),
  ],
);

/**
 * Snapshot membership row. Refreshed wholesale by the list refresh helper,
 * so the table can be safely TRUNCATE-and-INSERT per list (we use
 * INSERT/DELETE for partial updates so cron jobs don't churn unchanged
 * rows). Composite PK on (list_id, lead_id) prevents dupes.
 */
export const marketingListMembers = pgTable(
  "marketing_list_members",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => marketingLists.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /**
     * Denormalized so the marketing send path can JOIN suppressions →
     * filter recipients without a leads-table lookup. Updated on every
     * list refresh.
     */
    email: text("email").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({
      columns: [t.listId, t.leadId],
      name: "marketing_list_members_pkey",
    }),
    index("mkt_lm_email_idx").on(t.email),
    index("mkt_lm_lead_idx").on(t.leadId),
  ],
);
