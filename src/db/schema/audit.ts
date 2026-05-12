import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Append-only audit log. Every admin action, every delete, every permission
 * change writes one row. `before_json`/`after_json` hold the changed fields,
 * not the full record, to keep volume manageable.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot of actor's email at the time of the action. Preserved even
    // after the user is deleted (FK is SET NULL) so audit history stays
    // attributable for compliance/forensics.
    actorEmailSnapshot: text("actor_email_snapshot"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    beforeJson: jsonb("before_json"),
    afterJson: jsonb("after_json"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("audit_actor_idx").on(t.actorId),
    index("audit_action_idx").on(t.action),
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_created_idx").on(t.createdAt.desc()),
    // composite cursor key (created_at DESC, id DESC) so
    // the /admin/audit list seeks deterministically even when many rows
    // share a created_at to the millisecond (high-volume admin actions).
    index("audit_log_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);
