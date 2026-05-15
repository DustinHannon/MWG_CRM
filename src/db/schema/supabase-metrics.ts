import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Append-only Prometheus-style time-series for the Supabase Metrics
 * dashboard. Scraped once per minute by the
 * /api/cron/scrape-supabase-metrics handler, pruned daily by
 * /api/cron/prune-supabase-metrics (7-day retention).
 *
 * No foreign keys, no primary key. Isolation by design — see CLAUDE.md
 * "Database / migrations / Drizzle" and the feature's site-isolation
 * contract: a broken metrics feature cannot cascade-affect any other
 * production data.
 *
 * BRIN on `time` is the right index for a monotonically-increasing
 * insert pattern; the row pointer pages are physically clustered by
 * time so the planner can prune large swaths quickly. The btree on
 * (metric_name, time DESC) accelerates the snapshot query's
 * "latest N points for metric X" reads.
 *
 * BRIN index emission: drizzle-kit's BRIN support is incomplete in
 * 0.30; the generated migration SQL is hand-edited to read
 * `USING brin` before being applied via the Supabase MCP.
 */
export const supabaseMetrics = pgTable(
  "supabase_metrics",
  {
    /** Scrape start time. All rows from one scrape share this value. */
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    /** Prometheus metric name (e.g., `node_cpu_seconds_total`). */
    metricName: text("metric_name").notNull(),
    /** Subset of Prometheus labels retained per KEEP_LABELS in scrape handler. */
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    /** Raw counter or gauge value at scrape time. Rates are computed at read. */
    value: doublePrecision("value").notNull(),
  },
  (t) => [
    index("supabase_metrics_time_brin").using("brin", t.time),
    index("supabase_metrics_metric_time").on(t.metricName, t.time.desc()),
  ],
);

export type SupabaseMetricRow = typeof supabaseMetrics.$inferSelect;
export type NewSupabaseMetricRow = typeof supabaseMetrics.$inferInsert;
