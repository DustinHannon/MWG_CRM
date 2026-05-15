/**
 * Metric allowlist. The Supabase Prometheus endpoint emits ~200 series
 * per scrape; the dashboard renders ~30 derived charts that need a
 * specific subset. Anything not in this set is dropped at parse time so
 * storage stays bounded.
 *
 * Names verified against the Supabase reference dashboard:
 * https://github.com/supabase/supabase-grafana/blob/main/dashboard.json
 *
 * Supabase's metrics endpoint is in beta; names may evolve. Missing
 * metrics silently disappear from the chart — never an error. The
 * scrape handler logs scraped/matched/dropped counts per run for drift
 * detection.
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

  // Node — Boot / uptime
  "node_boot_time_seconds",
  "node_time_seconds",

  // Postgres — Connections / activity
  "pg_stat_database_numbackends",
  "pg_settings_max_connections",

  // Postgres — Transactions
  "pg_stat_database_xact_commit",
  "pg_stat_database_xact_rollback",

  // Postgres — Cache / IO
  "pg_stat_database_blks_read",
  "pg_stat_database_blks_hit",
  "pg_stat_database_tup_returned",
  "pg_stat_database_tup_fetched",
  "pg_stat_database_tup_inserted",
  "pg_stat_database_tup_updated",
  "pg_stat_database_tup_deleted",

  // Postgres — Conflicts / deadlocks
  "pg_stat_database_deadlocks",
  "pg_stat_database_conflicts",

  // Postgres — Database size
  "pg_database_size_bytes",

  // Postgres — Background writer / checkpointer
  "pg_stat_bgwriter_checkpoints_timed",
  "pg_stat_bgwriter_checkpoints_req",
  "pg_stat_bgwriter_buffers_checkpoint",
  "pg_stat_bgwriter_buffers_clean",
  "pg_stat_bgwriter_buffers_backend",

  // Postgres — Locks
  "pg_locks_count",

  // Replication (Realtime logical replication)
  "replication_realtime_slot_status",
  "replication_realtime_lag_bytes",

  // Supavisor (connection pooler)
  "supavisor_db_pool_size",
  "supavisor_db_clients_active",
  "supavisor_db_clients_waiting",
  "supavisor_db_servers_active",
  "supavisor_db_servers_idle",
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
