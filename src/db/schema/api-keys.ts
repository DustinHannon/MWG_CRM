import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Phase 13 — Bearer-token API keys for external integrations.
 *
 * Plaintext format: `mwg_live_<32 base32 chars>`. We hash with SHA-256
 * (single round; tokens are full-entropy random, bcrypt's slowdown buys
 * nothing) and store the 12-char prefix for display. Plaintext is shown
 * exactly once at generation; never again.
 *
 * Scopes are an unordered text[]: `read:leads`, `write:leads`, `delete:leads`,
 * etc., plus `admin` super-scope. Validated against an allowlist in
 * `src/lib/api/scopes.ts`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    description: text("description"),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedById: uuid("revoked_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: text("last_used_ip"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("api_keys_active_idx")
      .on(t.createdAt.desc())
      .where(sql`revoked_at IS NULL`),
    index("api_keys_hash_idx").on(t.keyHash),
    index("api_keys_creator_idx").on(t.createdById),
  ],
);

/**
 * Phase 13 — every API request appends one row, success or failure.
 * Snapshots `api_key_name_snapshot` and `api_key_prefix_snapshot` so
 * revoked or deleted keys retain attributable history. 730-day
 * retention is enforced by `/api/cron/retention-prune`.
 *
 * `request_body_summary` and `response_summary` are intentionally
 * shape-only (size + top-level fields, or {count: N}) to avoid PII in
 * logs. The caller writes these — never raw bodies.
 */
export const apiUsageLog = pgTable(
  "api_usage_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    apiKeyNameSnapshot: text("api_key_name_snapshot").notNull(),
    apiKeyPrefixSnapshot: text("api_key_prefix_snapshot").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    action: text("action"),
    statusCode: integer("status_code").notNull(),
    responseTimeMs: integer("response_time_ms"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    requestQuery: jsonb("request_query"),
    requestBodySummary: jsonb("request_body_summary"),
    responseSummary: jsonb("response_summary"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("api_usage_log_created_idx").on(t.createdAt.desc()),
    index("api_usage_log_key_idx").on(t.apiKeyId, t.createdAt.desc()),
    index("api_usage_log_status_idx")
      .on(t.statusCode, t.createdAt.desc())
      .where(sql`status_code >= 400`),
    index("api_usage_log_path_idx").on(t.path, t.createdAt.desc()),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiUsageLogRow = typeof apiUsageLog.$inferSelect;
