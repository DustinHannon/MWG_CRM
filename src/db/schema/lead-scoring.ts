import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * admin-curated rules that compute a lead score.
 * `predicate` is the saved-views filter JSON: same shape, same operators.
 * Engine: src/lib/scoring/engine.ts.
 */
export const leadScoringRules = pgTable(
  "lead_scoring_rules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    description: text("description"),
    predicate: jsonb("predicate").notNull(),
    points: integer("points").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => [index("lead_scoring_rules_active_idx").on(t.isActive)],
);

/**
 * single-row settings table holding the score band thresholds.
 * Constrained server-side via CHECK to enforce hot > warm > cool ordering.
 * The engine reads this table on every evaluation; admins edit via the
 * /admin/scoring sliders.
 */
export const leadScoringSettings = pgTable("lead_scoring_settings", {
  id: smallint("id").primaryKey().default(1),
  hotThreshold: integer("hot_threshold").notNull().default(70),
  warmThreshold: integer("warm_threshold").notNull().default(40),
  coolThreshold: integer("cool_threshold").notNull().default(15),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedById: uuid("updated_by_id").references(() => users.id, {
    onDelete: "set null",
  }),
  version: integer("version").notNull().default(1),
});
