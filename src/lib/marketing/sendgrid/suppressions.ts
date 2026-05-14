import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSendGrid } from "./client";

/**
 * Suppression list sync.
 *
 * Called by /api/cron/marketing-sync-suppressions hourly. Pulls
 * SendGrid's authoritative suppression lists (unsubscribes, bounces,
 * blocks, spam reports, invalid emails) and reconciles them with our
 * mirror in `marketing_suppressions`.
 *
 * Catches anything we missed via webhook drops + back-fills addresses
 * suppressed manually in the SendGrid console.
 *
 * Returns counts so the cron's response body and audit row can show
 * how much drift was caught.
 */

interface SyncResult {
  unsubscribes: number;
  groupUnsubscribes: number;
  bounces: number;
  blocks: number;
  spamReports: number;
  invalidEmails: number;
  total: number;
}

interface SendGridSuppressionEntry {
  email: string;
  created?: number;
  reason?: string;
  status?: string;
}

const ENDPOINTS: Array<{
  url: string;
  type:
    | "unsubscribe"
    | "group_unsubscribe"
    | "bounce"
    | "block"
    | "spamreport"
    | "invalid";
  resultKey: keyof Omit<SyncResult, "total">;
}> = [
  { url: "/v3/suppression/unsubscribes", type: "unsubscribe", resultKey: "unsubscribes" },
  { url: "/v3/suppression/bounces", type: "bounce", resultKey: "bounces" },
  { url: "/v3/suppression/blocks", type: "block", resultKey: "blocks" },
  { url: "/v3/suppression/spam_reports", type: "spamreport", resultKey: "spamReports" },
  { url: "/v3/suppression/invalid_emails", type: "invalid", resultKey: "invalidEmails" },
];

export async function syncSuppressions(): Promise<SyncResult> {
  const { sgClient } = getSendGrid();
  const result: SyncResult = {
    unsubscribes: 0,
    groupUnsubscribes: 0,
    bounces: 0,
    blocks: 0,
    spamReports: 0,
    invalidEmails: 0,
    total: 0,
  };

  for (const ep of ENDPOINTS) {
    try {
      const entries = await fetchAllPages(sgClient, ep.url);
      // Account-level endpoints return objects; defensively guard
      // against the rare malformed string entry just in case.
      const normalized = entries.map((e) =>
        typeof e === "string" ? { email: e } : e,
      );
      const count = await upsertBatch(normalized, ep.type);
      // We count rows synced (UPSERTs) not API entries returned, so the
      // result mirrors the actual db churn.
      result[ep.resultKey] = count;
      result.total += count;
    } catch (err) {
      logger.error("sendgrid.suppression_sync.endpoint_failed", {
        endpoint: ep.url,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Continue with the other endpoints — partial sync is better than nothing.
    }
  }

  // Per-group ASM suppressions. The marketing pipeline uses
  // ASM with a single `group_id`; the unsubscribe link in every
  // marketing email puts the recipient on this group's per-list, not
  // the account-wide list above. Without this sync, a webhook drop of
  // a `group_unsubscribe` event leaves the recipient marketable until
  // the next event re-fires. SendGrid does not retry webhooks past
  // 24h; this hourly sync is the safety net.
  const groupId = env.SENDGRID_UNSUBSCRIBE_GROUP_ID;
  if (groupId !== undefined) {
    try {
      const entries = await fetchAllPages(
        sgClient,
        `/v3/asm/groups/${groupId}/suppressions`,
      );
      // The /v3/asm/groups/{id}/suppressions endpoint returns a bare
      // array of email strings, not the `{email, reason, ...}` shape
      // of the account-level endpoints. Normalize so `upsertBatch`
      // can consume the same input shape.
      const normalized = entries.map((e) =>
        typeof e === "string" ? { email: e } : e,
      );
      const count = await upsertBatch(normalized, "group_unsubscribe");
      result.groupUnsubscribes = count;
      result.total += count;
    } catch (err) {
      logger.error("sendgrid.suppression_sync.endpoint_failed", {
        endpoint: `/v3/asm/groups/${groupId}/suppressions`,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function fetchAllPages(
  sgClient: ReturnType<typeof getSendGrid>["sgClient"],
  baseUrl: string,
): Promise<Array<SendGridSuppressionEntry | string>> {
  // Returned shape varies by endpoint: account-level suppression
  // endpoints return `[{ email, created, reason, status }]`; the
  // /v3/asm/groups/{id}/suppressions endpoint returns a bare `string[]`.
  // The caller normalizes both shapes downstream.
  const all: Array<SendGridSuppressionEntry | string> = [];
  let offset = 0;
  const limit = 500;
  // Cap iterations to avoid infinite loops on a misbehaving API.
  for (let i = 0; i < 200; i++) {
    const [response, body] = await sgClient.request({
      method: "GET",
      url: `${baseUrl}?limit=${limit}&offset=${offset}`,
    });
    if (response.statusCode === 404 || !Array.isArray(body)) {
      break;
    }
    const page = body as Array<SendGridSuppressionEntry | string>;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

async function upsertBatch(
  entries: SendGridSuppressionEntry[],
  type:
    | "unsubscribe"
    | "group_unsubscribe"
    | "bounce"
    | "block"
    | "spamreport"
    | "invalid",
): Promise<number> {
  if (entries.length === 0) return 0;
  // Chunk to keep parameter counts well under postgres-js's limits.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values = slice
      .filter((e) => typeof e.email === "string" && e.email.length > 0)
      .map((e) => ({
        email: e.email.toLowerCase(),
        suppressionType: type,
        reason: e.reason ?? e.status ?? null,
        suppressedAt: e.created ? new Date(e.created * 1000) : new Date(),
      }));
    if (values.length === 0) continue;
    const result = await db
      .insert(marketingSuppressions)
      .values(values)
      .onConflictDoUpdate({
        target: marketingSuppressions.email,
        set: {
          suppressionType: type,
          reason: sql`EXCLUDED.reason`,
          syncedAt: sql`now()`,
        },
      })
      .returning({ email: marketingSuppressions.email });
    inserted += result.length;
  }
  return inserted;
}
