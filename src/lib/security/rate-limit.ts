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
  | { kind: "campaign_send"; principal: string }
  // Phase 25 §6.2 — CSP violation report endpoint. Principal is the
  // sha256-hashed client IP (lower-case hex, 64 chars) so raw IPs
  // aren't persisted alongside the limiter bucket. Callers pass the
  // hash via `hashIpForRateLimit(ip)` from the csp-report route.
  | { kind: "csp_report"; principal: string }
  // Phase 26 §6 — geo-block audit emission throttle. Principal is the
  // sha256-hashed client IP for the same reason as csp_report — keeps
  // raw IPs out of the limiter bucket. Used by `src/proxy.ts` to bound
  // audit_log volume when a non-allowlisted source retries in a tight
  // loop.
  | { kind: "geo_block"; principal: string };

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
