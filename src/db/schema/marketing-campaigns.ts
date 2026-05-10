import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { marketingLists } from "./marketing-lists";
import { marketingTemplates } from "./marketing-templates";
import { users } from "./users";

/**
 * Phase 19 — Marketing campaign (one send of a template to a list).
 *
 * Status lifecycle:
 *   draft → scheduled → sending → sent
 *                    ↘ cancelled
 *                    ↘ failed
 *
 * The counters (total_sent / delivered / opened / clicked / bounced /
 * unsubscribed) are updated atomically by the SendGrid Event Webhook
 * handler. The wall-clock realtime view of a campaign's progress is
 * built from these columns + the campaign_recipients table.
 *
 * `from_email` / `from_name` are snapshotted at create time so that a
 * sender's display-name change later doesn't retroactively rewrite
 * historical campaigns.
 */
export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => marketingTemplates.id, { onDelete: "restrict" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => marketingLists.id, { onDelete: "restrict" }),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name").notNull(),
    replyToEmail: text("reply_to_email"),
    status: text("status", {
      enum: [
        "draft",
        "scheduled",
        "sending",
        "sent",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    totalRecipients: integer("total_recipients").notNull().default(0),
    totalSent: integer("total_sent").notNull().default(0),
    totalDelivered: integer("total_delivered").notNull().default(0),
    totalOpened: integer("total_opened").notNull().default(0),
    totalClicked: integer("total_clicked").notNull().default(0),
    totalBounced: integer("total_bounced").notNull().default(0),
    totalUnsubscribed: integer("total_unsubscribed").notNull().default(0),
    failureReason: text("failure_reason"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("mkt_camp_status_idx").on(t.status, t.updatedAt.desc()),
    /**
     * Cron processor pickup index — only scheduled campaigns matter here,
     * partial keeps it tiny.
     */
    index("mkt_camp_scheduled_pickup_idx")
      .on(t.scheduledFor)
      .where(sql`status = 'scheduled'`),
    index("mkt_camp_template_idx").on(t.templateId),
    index("mkt_camp_list_idx").on(t.listId),
  ],
);

/**
 * One row per recipient per campaign. Holds the SendGrid message id so
 * the webhook receiver can match events back to a specific (campaign,
 * lead, email) tuple.
 *
 * status mirrors SendGrid's terminal event state but with one important
 * difference: 'opened' / 'clicked' DO NOT advance away from 'delivered'
 * — they're tracked as flags via firstOpenedAt / firstClickedAt so a
 * recipient that opened, then later bounced (rare), doesn't lose the
 * open record.
 */
export const campaignRecipients = pgTable(
  "marketing_campaign_recipients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    /**
     * Nullable because campaigns can target ad-hoc recipient addresses
     * that never had a lead row (rare — typically only for test sends).
     */
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    email: text("email").notNull(),
    /** Returned from SendGrid as `x-message-id` response header. */
    sendgridMessageId: text("sendgrid_message_id"),
    status: text("status", {
      enum: [
        "queued",
        "sent",
        "delivered",
        "bounced",
        "dropped",
        "deferred",
        "blocked",
        "spamreport",
        "unsubscribed",
      ],
    })
      .notNull()
      .default("queued"),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
    lastClickedAt: timestamp("last_clicked_at", { withTimezone: true }),
    clickCount: integer("click_count").notNull().default(0),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    bounceReason: text("bounce_reason"),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("mkt_rcpt_campaign_idx").on(t.campaignId),
    index("mkt_rcpt_lead_idx").on(t.leadId),
    index("mkt_rcpt_email_idx").on(t.email),
    /**
     * Webhook receiver looks up by sendgrid_message_id. Unique because
     * one accepted /v3/mail/send call returns one message id; if the
     * same recipient is sent twice, that's a different campaign and a
     * different row.
     */
    uniqueIndex("mkt_rcpt_msgid_uniq")
      .on(t.sendgridMessageId)
      .where(sql`sendgrid_message_id IS NOT NULL`),
  ],
);

export type MarketingCampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

export type CampaignRecipientStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "dropped"
  | "deferred"
  | "blocked"
  | "spamreport"
  | "unsubscribed";
