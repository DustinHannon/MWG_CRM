import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingSuppressions } from "@/db/schema/marketing-events";
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
  type: "unsubscribe" | "bounce" | "block" | "spamreport" | "invalid";
  resultKey: keyof SyncResult;
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
    bounces: 0,
    blocks: 0,
    spamReports: 0,
    invalidEmails: 0,
    total: 0,
  };

  for (const ep of ENDPOINTS) {
    try {
      const entries = await fetchAllPages(sgClient, ep.url);
      const count = await upsertBatch(entries, ep.type);
      // We count rows synced (UPSERTs) not API entries returned, so the
      // result mirrors the actual db churn.
      result[ep.resultKey] = count as never; // keyof narrowing
      result.total += count;
    } catch (err) {
      logger.error("sendgrid.suppression_sync.endpoint_failed", {
        endpoint: ep.url,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Continue with the other endpoints — partial sync is better than nothing.
    }
  }

  return result;
}

async function fetchAllPages(
  sgClient: ReturnType<typeof getSendGrid>["sgClient"],
  baseUrl: string,
): Promise<SendGridSuppressionEntry[]> {
  const all: SendGridSuppressionEntry[] = [];
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
    const page = body as SendGridSuppressionEntry[];
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

async function upsertBatch(
  entries: SendGridSuppressionEntry[],
  type: "unsubscribe" | "bounce" | "block" | "spamreport" | "invalid",
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
