import { NextResponse } from "next/server";
import { writeSystemAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { WebhookSignatureError } from "@/lib/marketing/errors";
import { ipFromRequest, rateLimit } from "@/lib/security/rate-limit";
import {
  parseEvents,
  processEvent,
  readSignatureHeaders,
  tryClaimSgEvent,
  verifySendGridSignature,
  verifyTimestampFreshness,
} from "@/lib/marketing/sendgrid/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Phase 19 + 20 — SendGrid Event Webhook receiver.
 *
 * Public endpoint at /api/v1/webhooks/sendgrid/events. Auth is by ECDSA
 * signature (Signed Event Webhook). The CSP and proxy auth bypass for
 * /api/v1/* are already in place from Phase 13.
 *
 * Phase 20 hardening on every request:
 *   1. Body cap — Content-Length and read length both ≤ 1 MiB. SendGrid
 *      batches well under 100 KB; the cap exists to bound malicious
 *      payloads and prevent function-time exhaustion.
 *   2. Per-IP sliding-window rate limit at
 *      `RATE_LIMIT_WEBHOOK_PER_MINUTE`. Signature verification remains
 *      authoritative; the limit just prevents an unauthenticated client
 *      from forcing us to do ECDSA work in a tight loop.
 *   3. Timestamp freshness window of
 *      `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (default 300s). The
 *      signature alone does NOT prevent replay; this does.
 *   4. ECDSA signature verification (existing).
 *   5. Per-event idempotency on `sg_event_id` via
 *      `webhook_event_dedupe`. SendGrid retries non-2xx for 24h; this
 *      ensures a transient downstream failure cannot inflate counters
 *      or audit-log noise on retry.
 *
 * Every reject path emits a `marketing.security.webhook.*` audit row
 * via `writeSystemAudit` so SOC 2 has a forensic trail.
 *
 * Returns 200 quickly. SendGrid retries non-2xx responses for 24h, so
 * we want to ack fast and process inline. If processing partially fails
 * we still ack 200 — events are also reconciled by the hourly
 * suppression sync cron, so we don't need webhook-driven retry storms.
 */

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

export async function POST(req: Request): Promise<Response> {
  const ip = ipFromRequest(req);

  // 1. Body size cap (Content-Length precheck before reading).
  const declaredLength = Number.parseInt(
    req.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@webhook",
      action: "marketing.security.webhook.body_too_large",
      targetType: "marketing_webhook",
      ipAddress: ip,
      after: { declaredLength, limit: MAX_BODY_BYTES },
    });
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413 },
    );
  }

  // 2. Per-IP rate limit. Sliding window over 60 seconds.
  const rl = await rateLimit(
    { kind: "webhook", principal: ip },
    env.RATE_LIMIT_WEBHOOK_PER_MINUTE,
    60,
  );
  if (!rl.allowed) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@webhook",
      action: "marketing.security.rate_limit.exceeded",
      targetType: "marketing_webhook",
      ipAddress: ip,
      after: { limitPerMinute: env.RATE_LIMIT_WEBHOOK_PER_MINUTE },
    });
    return NextResponse.json(
      { ok: false, error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfter ?? 60),
        },
      },
    );
  }

  // CRITICAL: read body as raw text BEFORE any JSON parsing — the
  // signature verifies the exact bytes SendGrid signed.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@webhook",
      action: "marketing.security.webhook.body_too_large",
      targetType: "marketing_webhook",
      ipAddress: ip,
      after: { actualLength: rawBody.length, limit: MAX_BODY_BYTES },
    });
    return NextResponse.json(
      { ok: false, error: "Payload too large" },
      { status: 413 },
    );
  }

  const { signature, timestamp } = readSignatureHeaders(req.headers);

  // 3. Timestamp freshness — independent of signature so a bogus
  //    timestamp is rejected before we spend ECDSA cycles.
  try {
    verifyTimestampFreshness(timestamp);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      const action =
        err.reason === "replay_rejected"
          ? "marketing.security.webhook.replay_rejected"
          : "marketing.security.webhook.signature_failed";
      await writeSystemAudit({
        actorEmailSnapshot: "system@webhook",
        action,
        targetType: "marketing_webhook",
        ipAddress: ip,
        after: { reason: err.reason, hasTimestamp: timestamp != null },
      });
      logger.warn("sendgrid.webhook.freshness_failed", {
        reason: err.reason,
      });
      return NextResponse.json(
        { ok: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
    throw err;
  }

  // 4. ECDSA signature verification.
  try {
    verifySendGridSignature(rawBody, signature, timestamp);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      await writeSystemAudit({
        actorEmailSnapshot: "system@webhook",
        action: "marketing.security.webhook.signature_failed",
        targetType: "marketing_webhook",
        ipAddress: ip,
        after: {
          reason: err.reason,
          hasSignature: signature != null,
          hasTimestamp: timestamp != null,
        },
      });
      logger.warn("sendgrid.webhook.signature_failed", { reason: err.reason });
      return NextResponse.json(
        { ok: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
    throw err;
  }

  let events;
  try {
    events = parseEvents(rawBody);
  } catch (err) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@webhook",
      action: "marketing.security.webhook.malformed",
      targetType: "marketing_webhook",
      ipAddress: ip,
    });
    logger.error("sendgrid.webhook.parse_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Malformed payload" },
      { status: 400 },
    );
  }

  // 5. Per-event idempotency. Claim each `sg_event_id` exactly once.
  //    Duplicate events return success without reprocessing — SendGrid
  //    treats anything 2xx as acked, so this halts retry storms cleanly.
  let succeeded = 0;
  let failed = 0;
  let duplicates = 0;
  for (const event of events) {
    let claim: { claimed: boolean; bypassed: boolean };
    try {
      claim = await tryClaimSgEvent(event.sg_event_id);
    } catch (err) {
      // If the dedupe insert itself fails (DB blip), fall back to
      // processing — we'd rather double-process than drop an event.
      logger.error("sendgrid.webhook.dedupe_failed", {
        sgEventId: event.sg_event_id ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      claim = { claimed: true, bypassed: true };
    }
    if (!claim.claimed) {
      duplicates++;
      continue;
    }
    try {
      await processEvent(event);
      succeeded++;
    } catch (err) {
      failed++;
      // Don't let one bad event block the rest. The forensic event row
      // is already inserted before reconcile runs, so failures here are
      // just lost counter increments — caught by hourly resync.
      logger.error("sendgrid.webhook.event_failed", {
        event: event.event,
        sgMessageId: event.sg_message_id ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Throttle dupe audits: emit ONE row per webhook batch that contained
  // duplicates rather than one per event — a SendGrid retry storm could
  // arrive with hundreds of dupes and one row per is audit-log spam.
  if (duplicates > 0) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@webhook",
      action: "marketing.security.webhook.duplicate_event",
      targetType: "marketing_webhook",
      ipAddress: ip,
      after: { duplicates, totalEvents: events.length },
    });
  }

  logger.info("sendgrid.webhook.processed", {
    received: events.length,
    succeeded,
    failed,
    duplicates,
  });

  return NextResponse.json({
    ok: true,
    received: events.length,
    succeeded,
    failed,
    duplicates,
  });
}
