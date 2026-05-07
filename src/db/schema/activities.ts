import { sql } from "drizzle-orm";
import {
  bigint,
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
import { leads } from "./leads";
import { users } from "./users";

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
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
