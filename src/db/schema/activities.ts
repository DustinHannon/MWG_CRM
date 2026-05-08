import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activityDirectionEnum, activityKindEnum } from "./enums";
import { contacts, crmAccounts, opportunities } from "./crm-records";
import { leads } from "./leads";
import { users } from "./users";

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Phase 3G: lead_id is nullable now. CHECK constraint
    // `activities_one_parent` enforces exactly-one-of {lead, account,
    // contact, opportunity}. New rows must set exactly one parent.
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => crmAccounts.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: activityKindEnum("kind").notNull(),
    // null for note/task — they have no inbound/outbound concept.
    direction: activityDirectionEnum("direction"),
    subject: text("subject"),
    body: text("body"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes"),
    outcome: text("outcome"),
    meetingLocation: text("meeting_location"),
    // Each entry: { email, name, response: "accepted" | "declined" | ... }
    meetingAttendees: jsonb("meeting_attendees"),
    graphMessageId: text("graph_message_id"),
    graphEventId: text("graph_event_id"),
    graphInternetMessageId: text("graph_internet_message_id"),
    // Phase 6A — Snapshot of "By: Name" from imported D365 activity
    // bodies when the name doesn't resolve to a CRM user. When set,
    // userId/createdById will be NULL and the UI renders this with an
    // " (imported)" italic hint.
    importedByName: text("imported_by_name"),
    // Phase 6A — sha256(lead_id||kind||occurred_at_iso||body_first_200).
    // Set on import only; manually-created activities leave this NULL.
    // The activities_import_dedup_idx index makes re-imports idempotent.
    importDedupKey: text("import_dedup_key"),
    // Phase 10 — soft-delete columns. listActivitiesFor* must filter
    // is_deleted=false; deleteActivity now archives instead of dropping.
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("activities_lead_occurred_idx").on(t.leadId, t.occurredAt.desc()),
    index("activities_user_idx").on(t.userId),
    index("activities_kind_idx").on(t.kind),
    // Phase 10 — partial active indexes per parent type. The hot path
    // is "list activities for {parent}" which always filters is_deleted=false.
    index("activities_active_lead_idx")
      .on(t.leadId, t.occurredAt.desc())
      .where(sql`is_deleted = false AND lead_id IS NOT NULL`),
    index("activities_active_account_idx")
      .on(t.accountId, t.occurredAt.desc())
      .where(sql`is_deleted = false AND account_id IS NOT NULL`),
    index("activities_active_contact_idx")
      .on(t.contactId, t.occurredAt.desc())
      .where(sql`is_deleted = false AND contact_id IS NOT NULL`),
    index("activities_active_opportunity_idx")
      .on(t.opportunityId, t.occurredAt.desc())
      .where(sql`is_deleted = false AND opportunity_id IS NOT NULL`),
    index("activities_deleted_by_id_idx")
      .on(t.deletedById)
      .where(sql`deleted_by_id IS NOT NULL`),
    // Phase 6A — partial index on (lead_id, import_dedup_key) for the
    // re-import dedup lookup. Only indexes rows where dedup_key is set,
    // i.e., imported activities.
    index("activities_import_dedup_idx")
      .on(t.leadId, t.importDedupKey)
      .where(sql`import_dedup_key IS NOT NULL`),
    // Partial unique indexes prevent duplicate Graph imports.
    uniqueIndex("activities_graph_message_uniq")
      .on(t.graphMessageId)
      .where(sql`graph_message_id IS NOT NULL`),
    uniqueIndex("activities_graph_event_uniq")
      .on(t.graphEventId)
      .where(sql`graph_event_id IS NOT NULL`),
    uniqueIndex("activities_graph_intl_msg_uniq")
      .on(t.graphInternetMessageId)
      .where(sql`graph_internet_message_id IS NOT NULL`),
  ],
);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  activityId: uuid("activity_id")
    .notNull()
    .references(() => activities.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  blobUrl: text("blob_url").notNull(),
  blobPathname: text("blob_pathname").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
