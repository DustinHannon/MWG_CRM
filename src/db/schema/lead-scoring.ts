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
 * Phase 4C — admin-curated rules that compute a lead score.
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
