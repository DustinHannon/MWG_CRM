import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingEmailEvents } from "@/db/schema/marketing-events";

/**
 * Phase 21 — Lead-side rollup of marketing email activity.
 *
 * Groups every campaign that targeted this lead (via campaign_recipients)
 * with derived per-recipient metrics: delivered flag, open count, click
 * count, and a list of clicked URLs sourced from `marketing_email_events`.
 *
 * This is a server-only helper — server components fetch on render and
 * pass the rolled-up array to the timeline client component so the UI
 * doesn't waterfall.
 */

export interface EmailActivityClickEvent {
  url: string;
  clickedAt: Date;
}

export interface EmailActivityCampaignRollup {
  campaignId: string;
  campaignName: string;
  /** Campaign's wall-clock send timestamp; null while it hasn't shipped yet. */
  sentAt: Date | null;
  /**
   * Recipient row's terminal status (queued/sent/delivered/bounced/...).
   * Mirrors `campaign_recipients.status`.
   */
  status: string;
  /** True when the recipient row has a non-null deliveredAt. */
  delivered: boolean;
  firstOpenedAt: Date | null;
  openCount: number;
  firstClickedAt: Date | null;
  clickCount: number;
  /**
   * Distinct click events for this recipient. Sorted ascending by
   * timestamp. Capped at 50 to bound page weight on a high-traffic
   * recipient — the campaign detail page is the place to see every
   * click.
   */
  clicks: EmailActivityClickEvent[];
}

const CLICKS_PER_RECIPIENT_CAP = 50;

export async function getEmailActivityForLead(
  leadId: string,
): Promise<EmailActivityCampaignRollup[]> {
  // 1. Pull recipient rows + the parent campaign in one round-trip.
  //    Sorted by sentAt DESC so the timeline reads newest-first.
  const recipients = await db
    .select({
      recipientId: campaignRecipients.id,
      campaignId: marketingCampaigns.id,
      campaignName: marketingCampaigns.name,
      campaignSentAt: marketingCampaigns.sentAt,
      status: campaignRecipients.status,
      deliveredAt: campaignRecipients.deliveredAt,
      firstOpenedAt: campaignRecipients.firstOpenedAt,
      openCount: campaignRecipients.openCount,
      firstClickedAt: campaignRecipients.firstClickedAt,
      clickCount: campaignRecipients.clickCount,
    })
    .from(campaignRecipients)
    .innerJoin(
      marketingCampaigns,
      eq(marketingCampaigns.id, campaignRecipients.campaignId),
    )
    .where(
      and(
        eq(campaignRecipients.leadId, leadId),
        eq(marketingCampaigns.isDeleted, false),
      ),
    )
    .orderBy(desc(marketingCampaigns.sentAt));

  if (recipients.length === 0) return [];

  // 2. Pull every click event in one query, then bucket by campaignId.
  //    Filtering by leadId + eventType=click keeps the index sargable
  //    on `mkt_evt_lead_idx`.
  const clickRows = await db
    .select({
      campaignId: marketingEmailEvents.campaignId,
      url: marketingEmailEvents.url,
      eventTimestamp: marketingEmailEvents.eventTimestamp,
    })
    .from(marketingEmailEvents)
    .where(
      and(
        eq(marketingEmailEvents.leadId, leadId),
        eq(marketingEmailEvents.eventType, "click"),
      ),
    )
    .orderBy(marketingEmailEvents.eventTimestamp);

  const clicksByCampaign = new Map<string, EmailActivityClickEvent[]>();
  for (const row of clickRows) {
    if (!row.campaignId || !row.url) continue;
    const arr = clicksByCampaign.get(row.campaignId) ?? [];
    if (arr.length < CLICKS_PER_RECIPIENT_CAP) {
      arr.push({ url: row.url, clickedAt: row.eventTimestamp });
      clicksByCampaign.set(row.campaignId, arr);
    }
  }

  return recipients.map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    sentAt: r.campaignSentAt,
    status: r.status,
    delivered: r.deliveredAt !== null,
    firstOpenedAt: r.firstOpenedAt,
    openCount: r.openCount,
    firstClickedAt: r.firstClickedAt,
    clickCount: r.clickCount,
    clicks: clicksByCampaign.get(r.campaignId) ?? [],
  }));
}
