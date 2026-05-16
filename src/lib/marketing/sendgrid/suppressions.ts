import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  marketingSuppressions,
  type MarketingSuppressionType,
} from "@/db/schema/marketing-events";
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
          // Preserve a manual classification. An address an operator
          // manually suppressed that later turns up on a SendGrid list
          // (e.g. it also bounces) is still operator-managed; `manual`
          // is the higher-provenance label and must win over the synced
          // endpoint's type so the suppressions source-filter and UI
          // don't reclassify a deliberate manual entry as a bounce.
          suppressionType: sql`CASE WHEN ${marketingSuppressions.suppressionType} = 'manual'
                                    THEN 'manual'
                                    ELSE ${type} END`,
          reason: sql`EXCLUDED.reason`,
          syncedAt: sql`now()`,
        },
      })
      .returning({ email: marketingSuppressions.email });
    inserted += result.length;
  }
  return inserted;
}

/**
 * Remove an address from the corresponding SendGrid suppression list.
 *
 * Maps the local `suppression_type` value to the correct SendGrid v3
 * DELETE endpoint and issues the call. Returns `removed` when SendGrid
 * acknowledges the delete (HTTP 204), `not_in_list` when SendGrid reports
 * the address isn't on the list (HTTP 404 — treat as success because
 * the desired end state is "absent"), or `skipped` for the `manual`
 * type which is local-only by design and never lives at SendGrid.
 *
 * Throws on any other status code or network failure so the calling
 * action can refuse the local delete and surface the failure to the
 * admin instead of silently desyncing.
 *
 * Endpoints (per SendGrid v3 API):
 *   unsubscribe        -> /v3/asm/suppressions/global/{email}
 *   group_unsubscribe  -> /v3/asm/groups/{groupId}/suppressions/{email}
 *   bounce             -> /v3/suppression/bounces/{email}
 *   block              -> /v3/suppression/blocks/{email}
 *   spamreport         -> /v3/suppression/spam_reports/{email}
 *   invalid            -> /v3/suppression/invalid_emails/{email}
 *   manual             -> (skipped — local-only)
 */
export async function removeSuppressionFromSendGrid(
  email: string,
  suppressionType: MarketingSuppressionType,
): Promise<{ status: "removed" | "not_in_list" | "skipped" }> {
  if (suppressionType === "manual") {
    return { status: "skipped" };
  }

  const encoded = encodeURIComponent(email);
  let url: string;
  switch (suppressionType) {
    case "unsubscribe":
      url = `/v3/asm/suppressions/global/${encoded}`;
      break;
    case "group_unsubscribe": {
      const groupId = env.SENDGRID_UNSUBSCRIBE_GROUP_ID;
      if (typeof groupId !== "number") {
        throw new Error(
          "SENDGRID_UNSUBSCRIBE_GROUP_ID is not configured — cannot " +
            "remove group_unsubscribe suppression.",
        );
      }
      url = `/v3/asm/groups/${groupId}/suppressions/${encoded}`;
      break;
    }
    case "bounce":
      url = `/v3/suppression/bounces/${encoded}`;
      break;
    case "block":
      url = `/v3/suppression/blocks/${encoded}`;
      break;
    case "spamreport":
      url = `/v3/suppression/spam_reports/${encoded}`;
      break;
    case "invalid":
      url = `/v3/suppression/invalid_emails/${encoded}`;
      break;
  }

  const { sgClient } = getSendGrid();
  const [response] = await sgClient.request({ method: "DELETE", url });
  if (response.statusCode === 204 || response.statusCode === 200) {
    return { status: "removed" };
  }
  if (response.statusCode === 404) {
    logger.warn("sendgrid.suppression.delete_not_found", {
      email,
      suppressionType,
      url,
    });
    return { status: "not_in_list" };
  }
  // Anything else (5xx, 401, 403, 429, etc.) is a real failure. The
  // caller should refuse the local delete and surface the error to the
  // admin so they can retry or escalate. logger.error gives operators
  // the full context; the thrown error message is what the UI shows.
  logger.error("sendgrid.suppression.delete_failed", {
    email,
    suppressionType,
    url,
    statusCode: response.statusCode,
  });
  throw new Error(
    `SendGrid refused the suppression delete (HTTP ${response.statusCode}). ` +
      `The local record was NOT removed — retry, or contact support if this persists.`,
  );
}
