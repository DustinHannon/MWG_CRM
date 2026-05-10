import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { WebhookSignatureError } from "@/lib/marketing/errors";
import {
  parseEvents,
  processEvent,
  readSignatureHeaders,
  verifySendGridSignature,
} from "@/lib/marketing/sendgrid/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Phase 19 — SendGrid Event Webhook receiver.
 *
 * Public endpoint at /api/v1/webhooks/sendgrid/events. Auth is by ECDSA
 * signature (Signed Event Webhook). The CSP and proxy auth bypass for
 * /api/v1/* are already in place from Phase 13.
 *
 * Returns 200 quickly. SendGrid retries non-2xx responses for 24h, so
 * we want to ack fast and process inline. If processing partially fails
 * we still ack 200 — events are also reconciled by the hourly
 * suppression sync cron, so we don't need webhook-driven retry storms.
 */
export async function POST(req: Request): Promise<Response> {
  // CRITICAL: read body as raw text BEFORE any JSON parsing — the
  // signature verifies the exact bytes SendGrid signed.
  const rawBody = await req.text();
  const { signature, timestamp } = readSignatureHeaders(req.headers);

  try {
    verifySendGridSignature(rawBody, signature, timestamp);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
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
    logger.error("sendgrid.webhook.parse_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Malformed payload" },
      { status: 400 },
    );
  }

  let succeeded = 0;
  let failed = 0;
  for (const event of events) {
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

  logger.info("sendgrid.webhook.processed", {
    received: events.length,
    succeeded,
    failed,
  });

  return NextResponse.json({ ok: true, received: events.length, succeeded, failed });
}
