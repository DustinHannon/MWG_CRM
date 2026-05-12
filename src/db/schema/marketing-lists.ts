import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { users } from "./users";

/**
 * list type discriminator.
 *
 * `dynamic` — membership computed by evaluating `filter_dsl` against
 * `source_entity`. Snapshot lives in
 * `marketing_list_members` (lead-only today).
 * `static_imported` — membership is a flat email/name table populated by
 * CSV/XLSX import; lives in
 * `marketing_static_list_members`. `filter_dsl` is a
 * placeholder (empty rules).
 */
export const marketingListTypeEnum = pgEnum("marketing_list_type", [
  "dynamic",
  "static_imported",
]);

/**
 * source entity for dynamic lists.
 *
 * Only `leads` is wired today (the filter DSL is leads-scoped). The other
 * values are reserved so the picker can be shown for forward compatibility;
 * the UI disables anything but `leads` for now.
 */
export const marketingListSourceEntityEnum = pgEnum(
  "marketing_list_source_entity",
  ["leads", "contacts", "accounts", "opportunities", "mixed"],
);

/**
 * Marketing list (segment of recipients).
 *
 * A dynamic list is defined by a JSONB filter (`filter_dsl`) that is
 * evaluated against the source entity (today: `leads`). We snapshot
 * membership into `marketing_list_members` whenever the list is refreshed.
 *
 * adds `list_type` + `source_entity`. Static-imported lists
 * skip the filter DSL entirely; their members live in
 * `marketing_static_list_members`.
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
     * cross-entity filter DSL serialized as JSON. Shape:
     * { combinator: "AND" | "OR", rules: Array<{ field, op, value }> }
     * Evaluated server-side via @/lib/marketing/lists/refresh against the
     * source entity. Static-imported lists store an empty
     * `{ combinator: "AND", rules: [] }` placeholder — the resolver
     * branches on `list_type` before reading the DSL.
     */
    filterDsl: jsonb("filter_dsl").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    /**
     * discriminates dynamic vs. static-imported lists.
     */
    listType: marketingListTypeEnum("list_type")
      .notNull()
      .default("dynamic"),
    /**
     * source entity for dynamic lists. Nullable for
     * static-imported lists (which have no source entity).
     */
    sourceEntity: marketingListSourceEntityEnum("source_entity").default(
      "leads",
    ),
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
    /**
     * OCC (optimistic concurrency) version. Incremented
     * atomically on each update. The list-edit UI passes the version it
     * loaded; the UPDATE refuses to write if another writer bumped it.
     */
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("mkt_list_status_idx")
      .on(t.isDeleted, t.updatedAt.desc())
      .where(sql`is_deleted = false`),
    index("mkt_list_created_by_idx").on(t.createdById),
  ],
);

/**
 * Snapshot membership row for `list_type = 'dynamic'` lists. Refreshed
 * wholesale by the list refresh helper, so the table can be safely
 * TRUNCATE-and-INSERT per list (we use INSERT/DELETE for partial updates
 * so cron jobs don't churn unchanged rows). Composite PK on
 * (list_id, lead_id) prevents dupes.
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

/**
 * Static-imported list members.
 *
 * Each row is a recipient that was added by Excel/CSV import (or by
 * direct mass-edit on the static-list detail page). Lives separately
 * from `marketing_list_members` (which is the lead-snapshot table for
 * dynamic lists) so:
 * • Static rows can carry a free-text name + email without binding
 * to a CRM lead.
 * • The unique `(list_id, lower(email))` constraint deduplicates
 * case-insensitive addresses.
 *
 * Resolution at send time happens in `src/lib/marketing/lists/resolution.ts`
 * which branches on `marketing_lists.list_type` and reads the correct
 * source.
 */
export const marketingStaticListMembers = pgTable(
  "marketing_static_list_members",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    listId: uuid("list_id")
      .notNull()
      .references(() => marketingLists.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Case-insensitive dedup per list.
    uniqueIndex("mkt_static_lm_list_email_uniq").on(
      t.listId,
      sql`lower(${t.email})`,
    ),
    index("mkt_static_lm_list_idx").on(t.listId),
    index("mkt_static_lm_email_idx").on(sql`lower(${t.email})`),
    index("mkt_static_lm_created_by_idx").on(t.createdById),
    index("mkt_static_lm_updated_by_idx").on(t.updatedById),
  ],
);

export type MarketingListType = (typeof marketingListTypeEnum.enumValues)[number];
export type MarketingListSourceEntity =
  (typeof marketingListSourceEntityEnum.enumValues)[number];
