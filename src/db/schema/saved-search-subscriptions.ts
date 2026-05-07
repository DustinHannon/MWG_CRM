import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { savedViews } from "./views";
import { users } from "./users";

/**
 * Phase 3H — saved-search subscriptions. Cron runs daily; for each
 * active sub, scans new records (created_at > last_seen_max_created_at)
 * matching the saved view's filters. Always creates an in-app
 * notification; sends email digest if user_preferences.email_digest_frequency
 * matches the sub's frequency.
 */
export const savedSearchSubscriptions = pgTable(
  "saved_search_subscriptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    savedViewId: uuid("saved_view_id")
      .notNull()
      .references(() => savedViews.id, { onDelete: "cascade" }),
    frequency: text("frequency").notNull().default("daily"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSeenMaxCreatedAt: timestamp("last_seen_max_created_at", {
      withTimezone: true,
    }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("subs_active_idx").on(t.isActive, t.frequency, t.lastRunAt),
    unique("subs_user_view_uniq").on(t.userId, t.savedViewId),
  ],
);
