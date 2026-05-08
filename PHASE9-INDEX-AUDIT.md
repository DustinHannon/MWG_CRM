# Phase 9C — Index Audit & Cursor Pagination Plan

Generated 2026-05-07 (Sub-agent D, Phase 9C).
Database: Supabase project `ylsstqcvhkggjbxrgezg` (mwg-crm), Postgres 17.6.1.
Snapshot taken before high-volume traffic landed — current row counts
are 0–2 per table (post-foundation seed). Statistics matter — when this
table fills with 100k+ leads / 1M+ activities, planner choices change.

---

## 1. Diagnostic SQL run

The §6.4 detection queries from the build prompt were executed against
the prod database via Supabase MCP `execute_sql`. Output summarised
below; raw plans are appended where useful.

### 1.1 pg_stat_statements

`pg_stat_statements` extension version 1.11 is **installed**. The
top-30 by mean execution time on this fresh DB are dominated by
schema/migration DDL (one-time CREATE EXTENSION, ALTER USER, etc.)
and Supabase-internal catalog queries (`pg_timezone_names`,
introspection RPCs). No application query stands out as slow yet.

**Top app-level entries (mean_exec_time):**

| Query (preview) | calls | mean ms | total ms |
|---|---:|---:|---:|
| `insert into "leads" (...)` | 1 | 9.47 | 9.47 |
| `insert into "leads" (...)` (variant) | 2 | 7.42 | 14.85 |
| FK-integrity catalog probe (Phase 2A) | 1 | 10.19 | 10.19 |
| `pg_indexes` introspection (this audit) | 1 | 5.59 | 5.59 |

Action: re-run §6.4's `pg_stat_statements` query monthly post-launch.
A baseline snapshot lives in this section; deviations >5x mean ms or
calls >10k merit investigation. Reset via
`SELECT pg_stat_statements_reset();` after major data backfills so the
sample reflects steady-state load.

### 1.2 Missing FK indexes

Detection query (per §6.4) returned **0 rows** — every foreign-key
column is covered by at least one index leading on that column. No
action needed.

### 1.3 Unused indexes (`pg_stat_user_indexes.idx_scan = 0`)

55 candidates flagged. All are zero-scan because the database has not
served meaningful traffic yet (rowcount 0–2). **No drops are made in
this phase.** A re-run of the same query 30 days post-launch (or after
the first significant backfill) is the correct moment to act. Drop
candidates fall in three buckets:

#### Bucket A — likely real drop candidates after observation

These tend to duplicate a partial / composite index. Confirm zero
scans persist with real traffic before dropping.

| Index | Table | Likely redundant with |
|---|---|---|
| `leads_email_idx` | leads | `leads_fts_idx` (FTS covers email) for cross-entity search; `leads_external_id_unique` for dedupe |
| `leads_active_idx` | leads | `leads_updated_at_id_idx` (Phase 9C composite supersedes) |
| `leads_last_activity_idx` | leads | `leads_last_activity_id_idx` (Phase 9C composite supersedes) |
| `leads_company_idx` | leads | `leads_trgm_company_idx` (trigram covers prefix and contains) |
| `crm_accounts_owner_idx` | crm_accounts | covered by `crm_accounts_active_idx` for the dominant filtered path |
| `audit_target_idx` | audit_log | only used by ad-hoc target lookups; revisit once admin tooling stabilises |
| `audit_created_idx` | audit_log | `audit_log_created_at_id_idx` (Phase 9C composite supersedes) |

#### Bucket B — keep until Phase 7 actually exercises them

These exist for FK lookups that will fire on user delete / restore
flows or admin reassign flows — both of which are infrequent. Expect
zero scans for months and that is fine.

`leads_created_by_id_idx`, `leads_updated_by_id_idx`,
`leads_deleted_by_id_idx`, `crm_accounts_created_by_id_idx`,
`crm_accounts_deleted_by_id_idx`, `contacts_created_by_id_idx`,
`contacts_deleted_by_id_idx`, `opps_created_by_id_idx`,
`opportunities_deleted_by_id_idx`, `tasks_created_by_id_idx`,
`tasks_deleted_by_id_idx`, `lead_tags_added_by_id_idx`,
`opps_primary_contact_id_idx`, `users_manager_entra_oid_idx`.

#### Bucket C — Phase 9C additions (will populate with first real traffic)

`leads_updated_at_id_idx`, `leads_last_activity_id_idx`,
`crm_accounts_updated_at_id_idx`, `contacts_updated_at_id_idx`,
`opportunities_close_date_id_idx`, `opportunities_updated_at_id_idx`,
`audit_log_created_at_id_idx`, `tasks_assigned_due_at_id_idx`. These
are flagged "unused" because the migration is only minutes old. Confirm
they show scans within the first week of production traffic — if any
remain at zero scans 30 days after launch with users actively browsing,
the cursor refactor in `src/lib/leads.ts` / `views.ts` is not exercising
them and that is a bug, not a drop signal.

**Recommendation: do NOT drop in this phase. Schedule a follow-up audit
30 days after a representative production load.**

---

## 2. Indexes added by Phase 9C

All applied via Supabase MCP `apply_migration`. Names (= migration
names) below; each migration also sets a comment via
`COMMENT ON INDEX` so the rationale is discoverable from `psql \d+`.
The Drizzle schema (`src/db/schema/*.ts`) was updated in the same
commit so generated migrations stay aligned.

| Migration | Index | Table | Definition |
|---|---|---|---|
| `phase9_idx_leads_updated_at_id` | `leads_updated_at_id_idx` | leads | `(updated_at DESC, id DESC) WHERE is_deleted = false` |
| `phase9_idx_leads_last_activity_id` | `leads_last_activity_id_idx` | leads | `(last_activity_at DESC NULLS LAST, id DESC) WHERE is_deleted = false` |
| `phase9_idx_crm_accounts_updated_at_id` | `crm_accounts_updated_at_id_idx` | crm_accounts | `(updated_at DESC, id DESC) WHERE is_deleted = false` |
| `phase9_idx_contacts_updated_at_id` | `contacts_updated_at_id_idx` | contacts | `(updated_at DESC, id DESC) WHERE is_deleted = false` |
| `phase9_idx_opportunities_close_date_id` | `opportunities_close_date_id_idx` | opportunities | `(expected_close_date DESC NULLS LAST, id DESC) WHERE is_deleted = false` |
| `phase9_idx_opportunities_close_date_id` | `opportunities_updated_at_id_idx` | opportunities | `(updated_at DESC, id DESC) WHERE is_deleted = false` |
| `phase9_idx_audit_log_created_at_id` | `audit_log_created_at_id_idx` | audit_log | `(created_at DESC, id DESC)` |
| `phase9_idx_tasks_due_id` | `tasks_assigned_due_at_id_idx` | tasks | `(assigned_to_id, due_at ASC NULLS LAST, id DESC) WHERE is_deleted = false` |

**Total: 8 new composite indexes.** All partial except `audit_log`.
Net storage impact at current scale: ~8 KB each. Projected at 100k
active leads: <40 MB total across all 8 (well under any operational
threshold).

---

## 3. Cursor pagination strategy

Every list query that targets a table expected to grow past 50k rows
adopts the same cursor pattern.

| Page / module | Sort key | Cursor format | Page size |
|---|---|---|---|
| `/leads` (default sort) via `runView` | `(last_activity_at DESC NULLS LAST, id DESC)` | `<iso-or-"null">:<uuid>` | 50 |
| `/leads` (custom sort) via `runView` | varies | offset (legacy fallback) | 50 |
| `/accounts` | `(updated_at DESC, id DESC)` | `<iso>:<uuid>` | 50 |
| `/contacts` | `(updated_at DESC, id DESC)` | `<iso>:<uuid>` | 50 |
| `/opportunities` | `(expected_close_date DESC NULLS LAST, id DESC)` | `<yyyy-mm-dd-or-"null">:<uuid>` | 50 |
| `/tasks` | `(assigned_to_id, due_at ASC NULLS LAST, id DESC)` | `<iso-or-"null">:<uuid>` | 50 |
| `/notifications` | `(user_id, created_at DESC, id DESC)` | `<iso>:<uuid>` | 50 |
| `/admin/audit` | `(created_at DESC, id DESC)` | `<iso>:<uuid>` | 100 |
| `listLeads` (export) | `(last_activity_at DESC, id DESC)` | offset (`pageSize=10000`) | n/a |

Cursor codec: `parseCursor` / `encodeCursor` in `src/lib/leads.ts`.
Variants for tasks (`parseTaskCursor` / `encodeTaskCursor`),
notifications (`parseNotificationCursor` / `encodeNotificationCursor`),
and opportunities (inline). All variants share the structure
`<sort-key-string>:<uuid>` with `null` as the literal NULL sentinel.

WHERE-clause shape is the same across pages:

```sql
WHERE …existing filters…
  AND (
    sort_col < cursor_value::sort_type
    OR (sort_col = cursor_value::sort_type AND id < cursor_id)
    -- when NULLS LAST: append `OR sort_col IS NULL` and the
    -- non-null cursor case falls through to the NULL tail.
  )
ORDER BY sort_col DESC NULLS LAST, id DESC
LIMIT pageSize + 1
```

The `pageSize + 1` row trick lets the server detect "more results
exist" without running a separate `COUNT(*)` query. Cursor mode skips
COUNT entirely, which is the dominant win at 100k+ rows (COUNT scans
the whole filtered set; cursor-LIMIT exits as soon as the index
returns `pageSize + 1` matches).

---

## 4. EXPLAIN ANALYZE — representative queries

All plans collected via `EXPLAIN (ANALYZE, BUFFERS)` against prod
via Supabase MCP. Database is essentially empty, so cost numbers are
small; the takeaway is **what plan the planner chooses** with the new
indexes available.

### 4.1 Leads list, default sort + LIMIT 51

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, first_name, last_name, company_name, email, status,
       last_activity_at, created_at, updated_at
FROM leads
WHERE is_deleted = false
ORDER BY last_activity_at DESC NULLS LAST, id DESC
LIMIT 51;
```

```
Limit  (cost=1.03..1.03 rows=1 width=172) (actual time=0.044..0.044 rows=0)
  Buffers: shared hit=7
  ->  Sort  (cost=1.03..1.03 rows=1 width=172) (actual time=0.043..0.043 rows=0)
        Sort Key: last_activity_at DESC NULLS LAST, id DESC
        Sort Method: quicksort  Memory: 25kB
        ->  Seq Scan on leads  (cost=0.00..1.02 rows=1 width=172)
              Filter: (NOT is_deleted)   Rows Removed by Filter: 2
Planning Time: 1.357 ms
Execution Time: 0.117 ms
```

At 1 row Postgres prefers a Seq Scan over the new index — correct.
Once the partial index meaningfully exceeds the table's heap pages
(typically >1k active leads) the planner will switch to
`Index Scan using leads_last_activity_id_idx`. Re-run this query
post-load to confirm the switch.

### 4.2 Accounts list with cursor pagination

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, industry, owner_id, created_at, updated_at
FROM crm_accounts
WHERE is_deleted = false
ORDER BY updated_at DESC, id DESC
LIMIT 51;
```

```
Limit  (cost=0.12..8.87 rows=51 width=112) (actual time=0.005..0.006 rows=0)
  Buffers: shared hit=1
  ->  Index Scan using crm_accounts_updated_at_id_idx on crm_accounts
        (cost=0.12..12.98 rows=75 width=112) (actual time=0.004..0.004 rows=0)
        Buffers: shared hit=1
Planning Time: 1.094 ms
Execution Time: 0.064 ms
```

Index Scan adopted immediately because the new index supplies the
sort exactly. **No Sort node, no Incremental Sort.** This is the
target steady-state plan for /accounts.

### 4.3 Opportunities by close date

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, name, stage::text, amount, expected_close_date,
       account_id, owner_id, updated_at
FROM opportunities
WHERE is_deleted = false
ORDER BY expected_close_date DESC NULLS LAST, id DESC
LIMIT 51;
```

```
Limit  (cost=0.12..5.64 rows=51 width=142) (actual time=0.006..0.006 rows=0)
  ->  Index Scan using opportunities_close_date_id_idx on opportunities
        (cost=0.12..14.18 rows=130 width=142) (actual time=0.005..0.005 rows=0)
Planning Time: 1.041 ms
Execution Time: 0.059 ms
```

Same shape as accounts — the new composite NULLS LAST index drives the
plan. Pipeline forecasting reports will benefit from this index too.

### 4.4 Audit log cursor pagination

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, action, target_type, target_id, created_at
FROM audit_log
ORDER BY created_at DESC, id DESC
LIMIT 101;
```

```
Limit  (cost=3.20..3.29 rows=34 width=120) (actual time=0.082..0.088 rows=34)
  ->  Sort  (Sort Key: created_at DESC, id DESC) Memory: 29kB
        ->  Seq Scan on audit_log  (rows=34)
Planning Time: 0.607 ms
Execution Time: 0.138 ms
```

34 rows in a 16KB heap — Seq Scan is correct. Index will be selected
once audit_log crosses ~1000 rows. Re-verify at that point.

### 4.5 Cmd+K cross-entity search (leads FTS branch)

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, first_name, last_name, company_name, email
FROM leads l
WHERE l.is_deleted = false
  AND to_tsvector('english',
        coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
        coalesce(company_name,'') || ' ' || coalesce(email,'') || ' ' ||
        coalesce(phone,'')) @@ websearch_to_tsquery('english', 'acme')
LIMIT 20;
```

```
Limit  (cost=0.00..1.56 rows=1 width=144) (actual time=0.037..0.037 rows=0)
  ->  Seq Scan on leads l   Rows Removed by Filter: 2
Planning Time: 9.130 ms
Execution Time: 0.125 ms
```

`leads_fts_idx` exists but the planner currently picks Seq Scan
(2 rows). Verify post-load that Bitmap Index Scan kicks in — the
existing partial GIN index `leads_fts_idx` covers the same expression.
**Action item for production:** if FTS queries don't switch to bitmap
index scan after load, add an `EXISTS (SELECT 1 FROM leads ... ON CONFLICT DO NOTHING)`
warm-up to populate stats, or run `ANALYZE leads;` immediately after
the first import job. The Phase 4H index is correct; only stats need to
catch up.

### 4.6 Lead detail load (single row by id)

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, first_name, last_name, company_name, email,
       status, owner_id, version
FROM leads
WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
```

```
Seq Scan on leads  (cost=0.00..1.02 rows=1 width=168)
  Filter: (id = '00000000-...000001'::uuid)
Planning Time: 1.192 ms
Execution Time: 0.082 ms
```

Three rows — Seq Scan beats Index Scan trivially. Once the table grows
past the planner's `min_parallel_table_scan_size` threshold (default
8MB) it will switch to `Index Scan using leads_pkey`. Lead detail load
is the most-traversed query in the app; confirm it stays sub-millisecond
under load via the `pg_stat_statements` periodic snapshot.

---

## 5. Statement timeout convention

Phase 9C introduces a single in-app guard: the `/admin/audit` page
applies `SET LOCAL statement_timeout = '5s'` whenever a free-text
search (`q=`) is provided. Rationale: the `q` filter does ILIKE
across multiple columns including `target_id` (which is text-not-uuid
so we can search arbitrary entity ids), and there is no trigram /
FTS index on those columns — at 1M+ audit rows that scan can run
unbounded. 5s is generous for human browsing and aborts cleanly
if the planner picks a bad plan.

**Convention going forward:**
- The Vercel function wall is 60s (Hobby) / 300s (Pro) so the DB
  level timeout is the first-line guard; keep it well below the wall.
- Wrap risky paths only — do not blanket-apply. Most list queries are
  index-scan-then-LIMIT and don't need a timeout.
- Use `SET LOCAL` (transaction-scoped) not `SET` — connection pool
  reuse means a SET would leak to the next caller.
- When adding a new timeout, document it in `ARCHITECTURE.md`.

---

## 6. Connection pool notes (recap)

- Supabase Supavisor is the pool. The app uses `postgres-js` with
  `max: 1` per Lambda — see `src/db/index.ts`. This is intentional
  and per the `drizzle_supavisor_max1` memory: drizzle-orm ≥0.45 with
  Supavisor exhibits "Failed query" errors on warm-start when `max`
  is higher than 1.
- `prepare: false` is required because Supavisor does not support
  prepared statements across pooled connections.
- Idle timeout is 20s; connect timeout 10s. Both keep Lambda cold-paths
  well below the 60s wall.

No changes to pool configuration in this phase.

---

## 7. Re-audit checklist (30 days post-launch)

Run via Supabase MCP `execute_sql`:

```sql
-- 1. Verify Phase 9C indexes are now used
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'leads_updated_at_id_idx', 'leads_last_activity_id_idx',
  'crm_accounts_updated_at_id_idx', 'contacts_updated_at_id_idx',
  'opportunities_close_date_id_idx', 'opportunities_updated_at_id_idx',
  'audit_log_created_at_id_idx', 'tasks_assigned_due_at_id_idx'
)
ORDER BY indexrelname;
-- Expect: every row idx_scan > 0 within 7 days of users browsing the
-- corresponding pages.

-- 2. Top 30 slow queries — re-baseline
SELECT substring(query, 1, 200), calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(total_exec_time::numeric, 2) AS total_ms, rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY mean_exec_time DESC LIMIT 30;
-- Watchlist: anything app-layer above 250 ms mean.

-- 3. Drop candidates re-audit
SELECT relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i USING (indexrelid)
WHERE s.schemaname = 'public' AND s.idx_scan = 0
  AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;
-- Drop candidates only after this list stays stable across two
-- consecutive runs ≥7 days apart.
```
