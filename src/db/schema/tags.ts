import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { crmAccounts, contacts, opportunities } from "./crm-records";
import { tasks } from "./tasks";
import { users } from "./users";

/**
 * first-class tags. Each tag has a color from a fixed
 * brand-aligned palette; leads link via the `lead_tags` junction table.
 *
 * Color palette: slate (default), navy, blue, teal, green, amber, gold,
 * orange, rose, violet, gray. Each maps to --tag-<name> tokens defined
 * in globals.css for both light + dark mode.
 */
export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  color: text("color").notNull().default("slate"),
  createdById: uuid("created_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const leadTags = pgTable(
  "lead_tags",
  {
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.leadId, t.tagId], name: "lead_tags_pkey" }),
    index("lead_tags_tag_idx").on(t.tagId),
    // Matches the live DB partial index introduced earlier and mirrored
    // by drizzle/0011_phase32_6_added_by_id_indexes.sql on the other
    // four junction tables. Declared here for parity so pnpm db:generate
    // does not emit a DROP INDEX.
    index("lead_tags_added_by_id_idx")
      .on(t.addedById)
      .where(sql`${t.addedById} IS NOT NULL`),
  ],
);

export const accountTags = pgTable(
  "account_tags",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => crmAccounts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.tagId], name: "account_tags_pkey" }),
    index("account_tags_tag_idx").on(t.tagId),
    // Partial index on the FK column matches the live DB migration
    // (drizzle/0011_phase32_6_added_by_id_indexes.sql) and the canonical
    // lead_tags_added_by_id_idx posture. Required so future pnpm
    // db:generate runs do not emit a DROP INDEX for the live index.
    index("account_tags_added_by_id_idx")
      .on(t.addedById)
      .where(sql`${t.addedById} IS NOT NULL`),
  ],
);

export const contactTags = pgTable(
  "contact_tags",
  {
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId], name: "contact_tags_pkey" }),
    index("contact_tags_tag_idx").on(t.tagId),
    index("contact_tags_added_by_id_idx")
      .on(t.addedById)
      .where(sql`${t.addedById} IS NOT NULL`),
  ],
);

export const opportunityTags = pgTable(
  "opportunity_tags",
  {
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({
      columns: [t.opportunityId, t.tagId],
      name: "opportunity_tags_pkey",
    }),
    index("opportunity_tags_tag_idx").on(t.tagId),
    index("opportunity_tags_added_by_id_idx")
      .on(t.addedById)
      .where(sql`${t.addedById} IS NOT NULL`),
  ],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    addedById: uuid("added_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId], name: "task_tags_pkey" }),
    index("task_tags_tag_idx").on(t.tagId),
    index("task_tags_added_by_id_idx")
      .on(t.addedById)
      .where(sql`${t.addedById} IS NOT NULL`),
  ],
);

export const TAG_COLORS = [
  "slate",
  "navy",
  "blue",
  "teal",
  "green",
  "amber",
  "gold",
  "orange",
  "rose",
  "violet",
  "gray",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];
