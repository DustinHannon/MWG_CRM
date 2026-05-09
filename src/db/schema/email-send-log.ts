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
 * Phase 15 — every system-originated email attempt is recorded here, one row
 * per recipient per attempt. Separate from `audit_log` because audit is
 * per-action and one email send fans out to many recipients with their own
 * outcomes.
 *
 * Status lifecycle:
 *   queued     — row inserted, send not yet attempted (rare; we go straight
 *                to 'sending' in current code path).
 *   sending    — Graph call in flight.
 *   sent       — Graph accepted the message for delivery (HTTP 202). NOT
 *                a per-recipient deliverability guarantee — Graph doesn't
 *                surface bounces synchronously.
 *   failed     — Graph rejected the call (4xx/5xx) or threw network error.
 *   blocked_preflight — sender's mailbox is not exchange_online; we never
 *                hit Graph.
 *   blocked_e2e — subject or recipient contained the [E2E-…] sentinel; we
 *                never hit Graph (Phase 12 test convention).
 */
export const emailSendLog = pgTable(
  "email_send_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    fromUserEmailSnapshot: text("from_user_email_snapshot").notNull(),
    toEmail: text("to_email").notNull(),
    toUserId: uuid("to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    feature: text("feature").notNull(),
    featureRecordId: text("feature_record_id"),
    subject: text("subject").notNull(),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    attachmentCount: integer("attachment_count").notNull().default(0),
    totalSizeBytes: integer("total_size_bytes"),
    status: text("status").notNull(),
    graphMessageId: text("graph_message_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    requestId: text("request_id"),
    retryOfId: uuid("retry_of_id"),
  },
  (t) => [
    index("email_send_from_user_idx").on(t.fromUserId, t.queuedAt.desc()),
    index("email_send_status_idx")
      .on(t.status, t.queuedAt.desc())
      .where(sql`status IN ('failed','blocked_preflight')`),
    index("email_send_feature_idx").on(
      t.feature,
      t.featureRecordId,
      t.queuedAt.desc(),
    ),
    index("email_send_to_idx").on(t.toEmail, t.queuedAt.desc()),
  ],
);

export type EmailSendStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "blocked_preflight"
  | "blocked_e2e";
