import "server-only";
import { EventWebhook, EventWebhookHeader } from "@sendgrid/eventwebhook";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import {
  marketingEmailEvents,
  marketingSuppressions,
} from "@/db/schema/marketing-events";
import { webhookEventDedupe } from "@/db/schema/security";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { WebhookSignatureError } from "@/lib/marketing/errors";
import { ValidationError } from "@/lib/errors";

/**
 * SendGrid Event Webhook ingest.
 *
 * The webhook route handler does THREE things:
 * 1. Verify the ECDSA signature against SENDGRID_WEBHOOK_PUBLIC_KEY.
 * Drop on mismatch — never trust unsigned events.
 * 2. Append every event to `marketing_email_events` (forensic record).
 * 3. Reconcile state on `marketing_campaign_recipients` and bump the
 * counters on `marketing_campaigns`.
 *
 * The reconcile step is best-effort. If a webhook fires before our send
 * loop has inserted the recipient row (race), the event still lands in
 * the events table and the periodic suppression sync cron will catch
 * any state drift.
 */

const SendGridEventSchema = z.object({
  email: z.string(),
  timestamp: z.number(),
  event: z.string(),
  sg_message_id: z.string().optional(),
  sg_event_id: z.string().optional(),
  ip: z.string().optional(),
  useragent: z.string().optional(),
  url: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  // custom_args we set on send so we can match the event back
  campaign_id: z.string().optional(),
  recipient_id: z.string().optional(),
  lead_id: z.string().optional(),
}).passthrough();

export type SendGridEvent = z.infer<typeof SendGridEventSchema>;

/**
 * Verify the request signature using @sendgrid/eventwebhook. Throws
 * `WebhookSignatureError` on any failure path so the route handler can
 * map to a clean 401.
 */
export function verifySendGridSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
): void {
  if (!signatureHeader || !timestampHeader) {
    throw new WebhookSignatureError("missing_headers");
  }
  const publicKey = env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) {
    throw new WebhookSignatureError("no_public_key");
  }
  // The library accepts the raw base64 form returned by SendGrid's
  // signed-webhook settings endpoint. Some envs strip the PEM markers
  // `convertPublicKeyToECDSA` handles both. Any failure to convert
  // OR verify is treated as a signature failure (401), not a 500 —
  // a malformed signature header or unparseable public key from a
  // forged request is by definition an auth failure, and D-1
  // showed the raw Error path leaking to a 500 broke the audit trail.
  const ew = new EventWebhook();
  let valid = false;
  try {
    let ec: ReturnType<typeof ew.convertPublicKeyToECDSA>;
    try {
      ec = ew.convertPublicKeyToECDSA(publicKey);
    } catch (rawErr) {
      // SendGrid's Signed Event Webhook settings UI returns the public
      // key as bare base64 without PEM markers; the library's fromPem
      // requires the markers. Wrap and retry. The outer catch turns
      // any failure here into a 401, which is correct policy — but
      // logging the inner exception is essential for debugging a
      // genuinely malformed SENDGRID_WEBHOOK_PUBLIC_KEY env var,
      // because the eventual `verify_failed` message gives no clue
      // whether the problem is signature mismatch or key parse.
      const wrapped = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
      try {
        ec = ew.convertPublicKeyToECDSA(wrapped);
      } catch (wrappedErr) {
        logger.warn("sendgrid.webhook.public_key_parse_failed", {
          rawErr: rawErr instanceof Error ? rawErr.message : String(rawErr),
          wrappedErr:
            wrappedErr instanceof Error
              ? wrappedErr.message
              : String(wrappedErr),
        });
        throw new WebhookSignatureError("verify_failed");
      }
    }
    valid = ew.verifySignature(ec, rawBody, signatureHeader, timestampHeader);
  } catch (err) {
    if (err instanceof WebhookSignatureError) throw err;
    throw new WebhookSignatureError("verify_failed");
  }
  if (!valid) throw new WebhookSignatureError("verify_failed");
}

/**
 * Determine the SendGrid `Signature` and `Timestamp` headers. Header
 * names are returned by the library so we don't bake the strings.
 */
export function readSignatureHeaders(headers: Headers): {
  signature: string | null;
  timestamp: string | null;
} {
  return {
    signature: headers.get(EventWebhookHeader.SIGNATURE()),
    timestamp: headers.get(EventWebhookHeader.TIMESTAMP()),
  };
}

/**
 * Validate the SendGrid timestamp header is within an
 * acceptable freshness window (default ±300s, configurable via
 * `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`). The signature alone does not
 * prevent replay — a captured signed payload remains valid forever
 * until this freshness check is enforced.
 *
 * Returns the absolute delta in seconds when fresh; throws
 * `WebhookSignatureError` with `replay_rejected` reason when stale.
 *
 * Header value is the unix-seconds string SendGrid signs alongside the
 * body. NaN / non-numeric → reject as `missing_headers` (already-failed
 * signature check, but caller may invoke this in a different order).
 */
export function verifyTimestampFreshness(
  timestampHeader: string | null,
  toleranceSeconds: number = env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (!timestampHeader) {
    throw new WebhookSignatureError("missing_headers");
  }
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) {
    throw new WebhookSignatureError("missing_headers");
  }
  const delta = Math.abs(nowSeconds - ts);
  if (delta > toleranceSeconds) {
    // Distinct reason so the caller can route to a replay-specific
    // audit event. We re-use the same error class for simpler 401
    // mapping; the discriminant is the new `replay_rejected` value.
    throw new WebhookSignatureError("replay_rejected" as const);
  }
  return delta;
}

/**
 * Try to claim a `sg_event_id` for first-time processing.
 *
 * INSERT…ON CONFLICT DO NOTHING returns the row on insert and zero rows
 * on conflict. We use the row count as the discriminator:
 *
 * 1 row returned → first time; caller should run `processEvent`.
 * 0 rows → already seen; caller should skip.
 *
 * Events without `sg_event_id` (rare, legacy or non-standard) bypass
 * dedupe and are processed every time. We log them rather than reject
 * because the alternative is silently dropping a forensic row.
 */
export async function tryClaimSgEvent(
  sgEventId: string | undefined | null,
): Promise<{ claimed: boolean; bypassed: boolean }> {
  if (!sgEventId) {
    return { claimed: true, bypassed: true };
  }
  const inserted = await db
    .insert(webhookEventDedupe)
    .values({ sgEventId })
    .onConflictDoNothing({ target: webhookEventDedupe.sgEventId })
    .returning({ sgEventId: webhookEventDedupe.sgEventId });
  return { claimed: inserted.length > 0, bypassed: false };
}

/**
 * Parse the raw body as a JSON array of events. Keeps unknown event
 * shapes — we still want to record them so we don't lose forensics.
 */
export function parseEvents(rawBody: string): SendGridEvent[] {
  const parsed = JSON.parse(rawBody);
  if (!Array.isArray(parsed)) {
    // Domain-level — parsing user-supplied request body; route
    // handler maps this to HTTP 400 via the typed-error contract.
    throw new ValidationError("SendGrid event payload must be an array");
  }
  const out: SendGridEvent[] = [];
  for (const p of parsed) {
    const r = SendGridEventSchema.safeParse(p);
    if (r.success) {
      out.push(r.data);
      continue;
    }
    // Drop the unparseable event instead of force-casting an
    // attacker-controlled object as SendGridEvent and passing it to
    // downstream code that reads `.email` / `.timestamp` / `.event`.
    // The body's signature has already been verified (the route
    // runs verifySendGridSignature first), so an unparseable event
    // implies SendGrid emitted a shape we don't recognize — log the
    // diagnostic and skip rather than risk a route-handler crash.
    logger.warn("sendgrid.event.parse_failed", {
      issues: r.error.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
      })),
    });
  }
  return out;
}

/**
 * Process one event:
 * 1. Insert into marketing_email_events (always).
 * 2. Lookup recipient by sg_message_id (or custom_args).
 * 3. UPDATE campaign_recipients status / first*At / counters.
 * 4. UPDATE campaign-level counter (atomic: total_X = total_X + 1).
 * 5. For unsubscribe / spamreport / bounce: UPSERT into marketing_suppressions.
 *
 * Counter increments are scoped to "first time we see this transition"
 * via the recipient status flag, so duplicate webhook deliveries
 * (SendGrid retries) don't double-count.
 */
export async function processEvent(event: SendGridEvent): Promise<void> {
  const eventType = event.event;
  const eventTimestamp = new Date(event.timestamp * 1000);

  // Resolve recipient — by custom_args first (most reliable), fall back
  // to sg_message_id lookup.
  let recipientId: string | null = event.recipient_id ?? null;
  let leadId: string | null = event.lead_id ?? null;
  let campaignId: string | null = event.campaign_id ?? null;

  if (!recipientId && event.sg_message_id) {
    const [match] = await db
      .select({
        id: campaignRecipients.id,
        campaignId: campaignRecipients.campaignId,
        leadId: campaignRecipients.leadId,
      })
      .from(campaignRecipients)
      .where(sql`${campaignRecipients.sendgridMessageId} = ${event.sg_message_id}`)
      .limit(1);
    if (match) {
      recipientId = match.id;
      campaignId = campaignId ?? match.campaignId;
      leadId = leadId ?? match.leadId;
    }
  }

  // 1. Forensic record (always).
  await db.insert(marketingEmailEvents).values({
    recipientId,
    leadId,
    campaignId,
    email: event.email,
    sendgridMessageId: event.sg_message_id ?? null,
    eventType,
    eventTimestamp,
    ipAddress: event.ip ?? null,
    userAgent: event.useragent ?? null,
    url: event.url ?? null,
    reason: event.reason ?? null,
    rawPayload: event as unknown as object,
  });

  if (!recipientId || !campaignId) {
    // Unmatched event — common for legacy sg_message_ids or transactional
    // sends that wandered into the marketing webhook. Logged in the
    // events table; no further action.
    return;
  }

  // 2 & 3. Per-event reconcile.
  const reconciledCounter = await reconcileRecipientAndCampaign(
    recipientId,
    campaignId,
    eventType,
    eventTimestamp,
    event,
  );

  // 4. Suppressions for terminal events.
  if (eventType === "unsubscribe") {
    // Account-level unsubscribe. The user opted out at the SendGrid
    // account level (rare via the marketing footer — the footer's
    // ASM link produces `group_unsubscribe` instead). Mapped to
    // `unsubscribe` so the operator audit-trail distinguishes the
    // two flavors.
    await upsertSuppression(event.email, "unsubscribe", event.reason ?? null);
  } else if (eventType === "group_unsubscribe") {
    // Per-group unsubscribe. The CRM's marketing pipeline uses ASM
    // with a single `group_id`, so the unsubscribe link in every
    // marketing email produces this event type, NOT `unsubscribe`.
    // Mapped to a distinct `group_unsubscribe` suppression_type so:
    // (a) the events table and admin UI can distinguish the two,
    // (b) the hourly cron sync of /v3/asm/groups/{id}/suppressions
    //     can reconcile this type without collision.
    await upsertSuppression(
      event.email,
      "group_unsubscribe",
      event.reason ?? null,
    );
  } else if (eventType === "bounce") {
    // SendGrid's `bounce` event has type='hard'|'soft' in `type`;
    // a blocked-by-ISP event uses event='dropped' or `type='blocked'`.
    // Hard and soft bounces both reach the suppression list as
    // `bounce`; only the explicit `blocked` subtype is mapped to
    // `block` so the operator audit-trail can distinguish them.
    const isBlocked = event.type === "blocked";
    await upsertSuppression(
      event.email,
      isBlocked ? "block" : "bounce",
      event.reason ?? null,
    );
  } else if (eventType === "spamreport") {
    await upsertSuppression(event.email, "spamreport", null);
  } else if (eventType === "dropped") {
    // Dropped events from Invalid Email reach the suppression list as
    // `invalid` so future sends to the same address skip immediately.
    await upsertSuppression(event.email, "invalid", event.reason ?? null);
  }

  if (!reconciledCounter) {
    logger.info("sendgrid.event.no_counter_change", {
      eventType,
      campaignId,
      recipientId,
    });
  }
}

async function reconcileRecipientAndCampaign(
  recipientId: string,
  campaignId: string,
  eventType: string,
  ts: Date,
  event: SendGridEvent,
): Promise<boolean> {
  // Map event → recipient updates. Each branch is idempotent — repeats
  // of the same event (SendGrid retries on non-2xx) don't double-bump
  // counters because the WHERE predicate filters out already-applied
  // states.
  const tsSql = sql`${ts.toISOString()}::timestamptz`;
  let counterField: keyof typeof marketingCampaigns | null = null;

  if (eventType === "delivered") {
    const updated = await db
      .update(campaignRecipients)
      .set({ status: "delivered", deliveredAt: ts })
      .where(sql`${campaignRecipients.id} = ${recipientId} AND ${campaignRecipients.status} = 'sent'`)
      .returning({ id: campaignRecipients.id });
    if (updated.length > 0) counterField = "totalDelivered";
  } else if (eventType === "open") {
    const updated = await db.execute(sql`
      UPDATE marketing_campaign_recipients
      SET first_opened_at = COALESCE(first_opened_at, ${tsSql}),
          last_opened_at = ${tsSql},
          open_count = open_count + 1
      WHERE id = ${recipientId}
      RETURNING (first_opened_at = ${tsSql})::int AS first_open_flag
    `);
    const rows = (reconcileResultRows(updated) as unknown[]) as Array<{
      first_open_flag?: number | string | null;
    }>;
    if (rows.length > 0 && rows[0]?.first_open_flag) counterField = "totalOpened";
  } else if (eventType === "click") {
    const updated = await db.execute(sql`
      UPDATE marketing_campaign_recipients
      SET first_clicked_at = COALESCE(first_clicked_at, ${tsSql}),
          last_clicked_at = ${tsSql},
          click_count = click_count + 1
      WHERE id = ${recipientId}
      RETURNING (first_clicked_at = ${tsSql})::int AS first_click_flag
    `);
    const rows = (reconcileResultRows(updated) as unknown[]) as Array<{
      first_click_flag?: number | string | null;
    }>;
    if (rows.length > 0 && rows[0]?.first_click_flag) counterField = "totalClicked";
  } else if (eventType === "bounce") {
    const updated = await db
      .update(campaignRecipients)
      .set({
        status: "bounced",
        bouncedAt: ts,
        bounceReason: event.reason ?? null,
      })
      .where(sql`${campaignRecipients.id} = ${recipientId} AND ${campaignRecipients.status} NOT IN ('bounced','dropped','blocked')`)
      .returning({ id: campaignRecipients.id });
    if (updated.length > 0) counterField = "totalBounced";
  } else if (eventType === "dropped") {
    await db
      .update(campaignRecipients)
      .set({ status: "dropped", bounceReason: event.reason ?? null })
      .where(sql`${campaignRecipients.id} = ${recipientId} AND ${campaignRecipients.status} NOT IN ('bounced','dropped','blocked')`);
  } else if (eventType === "deferred") {
    await db
      .update(campaignRecipients)
      .set({ status: "deferred" })
      .where(sql`${campaignRecipients.id} = ${recipientId} AND ${campaignRecipients.status} = 'sent'`);
  } else if (eventType === "unsubscribe" || eventType === "group_unsubscribe") {
    const updated = await db
      .update(campaignRecipients)
      .set({ status: "unsubscribed", unsubscribedAt: ts })
      .where(sql`${campaignRecipients.id} = ${recipientId} AND ${campaignRecipients.unsubscribedAt} IS NULL`)
      .returning({ id: campaignRecipients.id });
    if (updated.length > 0) counterField = "totalUnsubscribed";
  } else if (eventType === "spamreport") {
    await db
      .update(campaignRecipients)
      .set({ status: "spamreport" })
      .where(sql`${campaignRecipients.id} = ${recipientId}`);
  }

  if (counterField) {
    const fieldNameSql = sql.raw(snakeCaseCol(counterField));
    await db.execute(sql`
      UPDATE marketing_campaigns
      SET ${fieldNameSql} = ${fieldNameSql} + 1, updated_at = now()
      WHERE id = ${campaignId}
    `);
    return true;
  }
  return false;
}

async function upsertSuppression(
  email: string,
  type:
    | "unsubscribe"
    | "group_unsubscribe"
    | "bounce"
    | "block"
    | "spamreport"
    | "invalid",
  reason: string | null,
): Promise<void> {
  await db
    .insert(marketingSuppressions)
    .values({ email, suppressionType: type, reason })
    .onConflictDoUpdate({
      target: marketingSuppressions.email,
      set: {
        suppressionType: type,
        reason,
        syncedAt: sql`now()`,
      },
    });
}

function snakeCaseCol(camel: string): string {
  // Drizzle TS keys → SQL column names. Only used for the campaign
  // counter columns which have predictable shapes. the
  // fallback regex was removed: the value is fed through `sql.raw`
  // and any non-allowlisted key would land directly in the UPDATE
  // statement. Defense in depth: throw on unknown keys so a future
  // refactor that broadens `counterField` past the allowlist fails
  // closed instead of silently accepting an attacker-controlled
  // identifier. The current call site already constrains
  // `counterField` to a typed literal union, so this throw is a
  // belt-and-braces invariant guard, not a runtime branch reached
  // by any valid input.
  const map: Record<string, string> = {
    totalSent: "total_sent",
    totalDelivered: "total_delivered",
    totalOpened: "total_opened",
    totalClicked: "total_clicked",
    totalBounced: "total_bounced",
    totalUnsubscribed: "total_unsubscribed",
  };
  const mapped = map[camel];
  if (!mapped) {
    // Invariant violation — bare Error is correct here per CLAUDE.md.
    throw new Error(`snakeCaseCol: refusing to translate non-allowlisted key '${camel}'.`);
  }
  return mapped;
}

/**
 * Drizzle's `db.execute(sql\`…\`)` returns a driver-specific shape (rows
 * via `.rows` for postgres-js; iterable for some drivers). Normalize.
 */
function reconcileResultRows(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null && "rows" in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r;
  }
  return [];
}
