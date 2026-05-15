/**
 * Metric allowlist. This Supabase project's Prometheus endpoint emits
 * exactly these 28 series per scrape; the dashboard derives every chart
 * from this subset. Anything not in this set is dropped at parse time
 * so storage stays bounded.
 *
 * The set is the empirically observed emission, not the Supabase
 * reference dashboard's superset — pg_stat_database_*, supavisor_db_*,
 * pg_stat_bgwriter_*, pg_locks_count, and the node uptime pair are
 * documented in the reference dashboard but are never emitted by this
 * project's endpoint, so storing them would only accumulate dead names.
 *
 * The endpoint is in beta; names may evolve. Missing metrics silently
 * disappear from the chart — never an error. The scrape handler logs
 * scraped/matched/dropped counts per run for drift detection.
 */
export const METRIC_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Node — CPU
  "node_cpu_seconds_total",

  // Node — Memory
  "node_memory_MemTotal_bytes",
  "node_memory_MemAvailable_bytes",
  "node_memory_MemFree_bytes",
  "node_memory_Cached_bytes",
  "node_memory_Buffers_bytes",
  "node_memory_SwapTotal_bytes",
  "node_memory_SwapFree_bytes",

  // Node — Load
  "node_load1",
  "node_load5",
  "node_load15",

  // Node — Filesystem
  "node_filesystem_size_bytes",
  "node_filesystem_avail_bytes",
  "node_filesystem_files",
  "node_filesystem_files_free",

  // Node — Network
  "node_network_receive_bytes_total",
  "node_network_transmit_bytes_total",
  "node_network_receive_errs_total",
  "node_network_transmit_errs_total",

  // Node — Disk
  "node_disk_io_now",
  "node_disk_io_time_seconds_total",
  "node_disk_read_bytes_total",
  "node_disk_written_bytes_total",
  "node_disk_reads_completed_total",
  "node_disk_writes_completed_total",

  // Postgres — Database size
  "pg_database_size_bytes",

  // Replication (Realtime logical replication)
  "replication_realtime_slot_status",
  "replication_realtime_lag_bytes",
]);

/**
 * Labels retained after the allowlist filter. Everything else is
 * stripped so the jsonb column doesn't bloat. These are the labels
 * the dashboard actually reads — `mode` for CPU stacking, `device` /
 * `mountpoint` for disk + network, `datname` / `state` for Postgres.
 */
export const KEEP_LABELS: ReadonlySet<string> = new Set<string>([
  "mode",
  "cpu",
  "device",
  "mountpoint",
  "datname",
  "state",
]);
