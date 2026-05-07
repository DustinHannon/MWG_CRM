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
import { users } from "./users";

/**
 * Phase 3C — first-class tags. Each tag has a color from a fixed
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
