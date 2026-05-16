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
 * recently-viewed records, used by the Cmd+K palette and any
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
    /**
     * Polymorphic by design: free-text entity_type + entity_id with no
     * FK (a single column cannot reference five different tables).
     * Dangling rows after a hard-delete/purge are expected — resolve
     * queries gate on the target's is_deleted and drop unresolved rows,
     * the delete/purge paths best-effort clean these, and orphan-scan
     * reports any stragglers. Do not add an FK here.
     */
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
