import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * sliding-window rate-limit buckets.
 *
 * The application-layer rate limiter (`src/lib/security/rate-limit.ts`)
 * partitions counters into discrete time windows keyed by
 * `(kind, principal, window_start)`. A request increments the row for
 * the current window via INSERT…ON CONFLICT DO UPDATE; the limiter
 * also reads the prior window so the effective rate is a smooth
 * sliding average (current_count + prior_count * elapsed_fraction).
 *
 * Rows are pruned by the daily retention-prune cron (>1 day old).
 * Volume is bounded: per principal, at most one row per active
 * window — so a 60-second window means ≤ 1440 rows/day per principal.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    /** Bucket family: "webhook" | "test_send" | "filter_preview" | "campaign_send" | "api_key". */
    kind: text("kind").notNull(),
    /** What identifies the caller within the kind: IP, user id, key id, …. */
    principal: text("principal").notNull(),
    /**
     * Window start aligned to the configured window size (e.g. for a
     * 60s window: floor(now / 60s)). The limiter computes this — the
     * column stores it verbatim so we can prune old windows by
     * `window_start < now() - interval '1 day'`.
     */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.principal, t.windowStart] }),
    index("rate_limit_buckets_window_start_idx").on(t.windowStart.desc()),
  ],
);

/**
 * webhook idempotency dedupe.
 *
 * SendGrid retries non-2xx responses for up to 24 hours. To prevent
 * counter inflation, audit-log noise, and double suppressions if a
 * downstream insert transiently 5xx'd, the receiver records each
 * `sg_event_id` it has accepted. A second arrival of the same
 * `sg_event_id` returns 200 fast and emits a duplicate-event audit row
 * without re-running `processEvent`.
 *
 * Rows older than 7 days are pruned by retention-prune (well past
 * SendGrid's retry window).
 */
export const webhookEventDedupe = pgTable(
  "webhook_event_dedupe",
  {
    /**
     * SendGrid `sg_event_id`. Globally unique per event. We store text
     * verbatim — no need to parse.
     */
    sgEventId: text("sg_event_id").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("webhook_event_dedupe_received_idx").on(t.receivedAt.desc())],
);
