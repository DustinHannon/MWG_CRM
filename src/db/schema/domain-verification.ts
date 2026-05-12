import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * domain_verification_status — external service URL configuration state
 * tracking for the canonical-host migration. Each row represents one
 * external surface that must be re-pointed at `crm.morganwhite.com`
 * during cutover. The /admin/system/domain-status dashboard reads from
 * this table and writes the result of each verification check.
 *
 * Seeded on migration apply with one row per service in the runbook.
 * Status transitions: pending → verified | failed → pending (on re-run).
 *
 * Rows are immutable identifiers; only `configured_url`,
 * `last_checked_at`, `status`, `error_detail`, and the
 * `manually_confirmed_*` columns are updated.
 */
export const domainVerificationStatus = pgTable(
  "domain_verification_status",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    serviceName: text("service_name").notNull().unique(),
    /** Most recent value observed from the service's API, or null if manual-only. */
    configuredUrl: text("configured_url"),
    /** Value the service SHOULD show post-cutover. Set at seed time. */
    expectedUrl: text("expected_url").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** "pending" | "verified" | "failed" — enforced by CHECK constraint. */
    status: text("status").notNull().default("pending"),
    errorDetail: jsonb("error_detail"),
    manuallyConfirmedById: uuid("manually_confirmed_by_id"),
    manuallyConfirmedAt: timestamp("manually_confirmed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("domain_verification_status_status_idx").on(t.status),
  ],
);
