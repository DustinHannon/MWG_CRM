import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Phase 3I — recently-viewed records, used by the Cmd+K palette and any
 * future "recently viewed" surface. Upserted on every detail page load
 * (server-side fire-and-forget). Trim to 50 entries per user on each
 * write.
 */
export const recentViews = pgTable(
  "recent_views",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({
      columns: [t.userId, t.entityType, t.entityId],
      name: "recent_views_pkey",
    }),
    index("recent_views_user_time_idx").on(t.userId, t.viewedAt.desc()),
  ],
);
