import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { campaignRecipients, marketingCampaigns } from "./marketing-campaigns";

/**
 * Phase 19 — Raw event stream from SendGrid Event Webhook.
 *
 * Append-only. Every event we receive — even ones we can't immediately
 * match to a recipient/campaign — gets a row so a forensic replay is
 * possible. The webhook receiver also updates `marketing_campaign_recipients`
 * and the campaign counters in the same transaction; this table is the
 * audit trail of what arrived from SendGrid, not the source of truth for
 * recipient state.
 *
 * Retention is governed by /api/cron/retention-prune. Default 730 days
 * to mirror audit_log.
 */
export const marketingEmailEvents = pgTable(
  "marketing_email_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /**
     * Nullable — events can arrive before we've matched them. We keep
     * the row anyway and reconcile via sendgrid_message_id.
     */
    recipientId: uuid("recipient_id").references(
      () => campaignRecipients.id,
      { onDelete: "set null" },
    ),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    campaignId: uuid("campaign_id").references(
      () => marketingCampaigns.id,
      { onDelete: "set null" },
    ),
    email: text("email").notNull(),
    sendgridMessageId: text("sendgrid_message_id"),
    /**
     * Verbatim from SendGrid: 'processed' | 'delivered' | 'open' | 'click'
     * | 'bounce' | 'dropped' | 'deferred' | 'unsubscribe' | 'spamreport'
     * | 'group_unsubscribe' | 'group_resubscribe' | 'blocked'.
     */
    eventType: text("event_type").notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true })
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Click target URL — populated for `click` events. */
    url: text("url"),
    /** Bounce/drop reason text. */
    reason: text("reason"),
    /**
     * Full event JSON. Used for incident replay if our parsing was wrong
     * or if SendGrid adds new fields. Bounded — we strip nothing, but
     * SendGrid event payloads are small (< 4KB).
     */
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("mkt_evt_email_idx").on(t.email, t.eventTimestamp.desc()),
    index("mkt_evt_campaign_idx").on(t.campaignId),
    index("mkt_evt_lead_idx").on(t.leadId),
    index("mkt_evt_msgid_idx").on(t.sendgridMessageId),
    index("mkt_evt_type_idx").on(t.eventType),
    index("mkt_evt_received_idx").on(t.receivedAt.desc()),
  ],
);

/**
 * Mirror of SendGrid's authoritative suppression list. Populated by the
 * Event Webhook (real-time) and reconciled hourly by the
 * /api/cron/marketing-sync-suppressions cron (catches anything we missed
 * via webhook drops).
 *
 * The marketing send path JOIN-filters against this on every batch so
 * suppressed addresses never reach SendGrid even if they're still in a
 * campaign's recipient list.
 */
export const marketingSuppressions = pgTable(
  "marketing_suppressions",
  {
    email: text("email").primaryKey(),
    suppressionType: text("suppression_type", {
      enum: [
        "unsubscribe",
        "group_unsubscribe",
        "bounce",
        "block",
        "spamreport",
        "invalid",
      ],
    }).notNull(),
    reason: text("reason"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("mkt_sup_type_idx").on(t.suppressionType),
    index("mkt_sup_synced_idx").on(t.syncedAt.desc()),
  ],
);

export type MarketingSuppressionType =
  | "unsubscribe"
  | "group_unsubscribe"
  | "bounce"
  | "block"
  | "spamreport"
  | "invalid";
