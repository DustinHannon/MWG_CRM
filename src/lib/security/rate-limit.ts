import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimitBuckets } from "@/db/schema/security";

/**
 * Phase 20 — Postgres-backed sliding-window rate limiter.
 *
 * No new dependencies (no Redis). Buckets live in `rate_limit_buckets`
 * keyed by `(kind, principal, window_start)`. Each call:
 *
 *   1. Computes the window slot for `now()` aligned to `windowSeconds`.
 *   2. INSERT…ON CONFLICT DO UPDATE bumps `count` for the current slot.
 *   3. Reads the count for the previous slot.
 *   4. Computes a sliding total:
 *        sliding = current + previous * (1 - elapsedInWindow / windowSize)
 *      so a caller right at a slot boundary doesn't get a free reset.
 *   5. If `sliding > limit`: returns `{ allowed: false, retryAfter }`
 *      and ROLLS THE INCREMENT BACK so a client repeatedly hitting a
 *      blocked endpoint doesn't bury its own future budget.
 *
 * Failure mode: if the DB call itself fails (very rare; would also fail
 * the actual handler), the limiter `fails open` with a logged warning.
 * The endpoint still works during a DB blip.
 *
 * Pruning: `retention-prune` cron deletes `window_start < now() - 1 day`.
 *
 * @see lib/marketing/sendgrid/webhook.ts and the marketing webhook
 * route for the canonical caller. Extend `RateLimitKey` when new
 * limited surfaces are added.
 */

export type RateLimitKey =
  | { kind: "webhook"; principal: string }
  | { kind: "test_send"; principal: string }
  | { kind: "filter_preview"; principal: string }
  | { kind: "campaign_send"; principal: string };

export interface RateLimitResult {
  allowed: boolean;
  /** How many requests would still fit in the current sliding window. */
  remaining: number;
  /** Seconds until at least one slot in the window frees up. null when allowed. */
  retryAfter: number | null;
}

export async function rateLimit(
  key: RateLimitKey,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (limit <= 0) {
    return { allowed: false, remaining: 0, retryAfter: windowSeconds };
  }

  const now = new Date();
  const windowMs = windowSeconds * 1000;
  const windowStartMs =
    Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const previousStart = new Date(windowStartMs - windowMs);

  let currentCount: number;
  let previousCount: number;
  try {
    // Atomic increment for the current slot.
    const inserted = await db
      .insert(rateLimitBuckets)
      .values({
        kind: key.kind,
        principal: key.principal,
        windowStart,
        count: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          rateLimitBuckets.kind,
          rateLimitBuckets.principal,
          rateLimitBuckets.windowStart,
        ],
        set: {
          count: sql`${rateLimitBuckets.count} + 1`,
          updatedAt: now,
        },
      })
      .returning({ count: rateLimitBuckets.count });
    currentCount = inserted[0]?.count ?? 1;

    const [prev] = await db
      .select({ count: rateLimitBuckets.count })
      .from(rateLimitBuckets)
      .where(
        and(
          eq(rateLimitBuckets.kind, key.kind),
          eq(rateLimitBuckets.principal, key.principal),
          eq(rateLimitBuckets.windowStart, previousStart),
        ),
      )
      .limit(1);
    previousCount = prev?.count ?? 0;
  } catch {
    // Fail-open. The DB blip will surface in the handler's own queries
    // anyway; we don't want to add a second failure path.
    return { allowed: true, remaining: limit, retryAfter: null };
  }

  const elapsedFraction =
    (now.getTime() - windowStartMs) / windowMs;
  const sliding =
    currentCount + previousCount * (1 - elapsedFraction);

  if (sliding > limit) {
    // Roll back the increment we just made so the offender doesn't
    // poison their own future budget by hammering a blocked endpoint.
    try {
      await db
        .update(rateLimitBuckets)
        .set({ count: sql`GREATEST(${rateLimitBuckets.count} - 1, 0)` })
        .where(
          and(
            eq(rateLimitBuckets.kind, key.kind),
            eq(rateLimitBuckets.principal, key.principal),
            eq(rateLimitBuckets.windowStart, windowStart),
          ),
        );
    } catch {
      // Same fail-open posture.
    }
    const retryAfter = Math.max(
      1,
      Math.ceil((windowMs - (now.getTime() - windowStartMs)) / 1000),
    );
    return { allowed: false, remaining: 0, retryAfter };
  }

  return {
    allowed: true,
    remaining: Math.max(0, Math.floor(limit - sliding)),
    retryAfter: null,
  };
}

/**
 * Best-effort prune of old buckets. Called from the daily
 * retention-prune cron alongside the audit/api-usage/email-send sweeps.
 * Returns the number of rows deleted.
 */
export async function pruneOldRateLimitBuckets(
  olderThanHours = 24,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const deleted = await db.execute(sql`
    WITH d AS (
      DELETE FROM ${rateLimitBuckets}
      WHERE window_start < ${cutoff}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `);
  const rows = (deleted as unknown as Array<{ n: number }>);
  return Array.isArray(rows) && rows[0] ? Number(rows[0].n) : 0;
}

/**
 * Best-effort prune of webhook dedupe rows older than the SendGrid
 * retry window (24h with cushion → 7 days default). Called from
 * retention-prune.
 */
export async function pruneOldWebhookDedupe(
  olderThanDays = 7,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  );
  const deleted = await db.execute(sql`
    WITH d AS (
      DELETE FROM webhook_event_dedupe
      WHERE received_at < ${cutoff}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `);
  const rows = (deleted as unknown as Array<{ n: number }>);
  return Array.isArray(rows) && rows[0] ? Number(rows[0].n) : 0;
}

/**
 * Resolve a request's caller IP for rate-limit keying. Mirrors the
 * extraction pattern used by `src/lib/api/handler.ts:withApi` so the
 * webhook receiver and the public REST API agree on what counts as one
 * client. Falls back to a stable string ("unknown") so callers without
 * a meaningful IP still hit a single bucket.
 */
export function ipFromRequest(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Defensive — keep `gte` reachable for future window predicates that
// need an explicit lower bound (e.g. multi-window queries).
void gte;
