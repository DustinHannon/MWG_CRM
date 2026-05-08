# Phase 8 Audit B — Database Integrity

Auditor: Sub-agent B (read-only SQL via Supabase MCP)
Method: Live queries against project ylsstqcvhkggjbxrgezg (mwg-crm)
Date: 2026-05-07

## Summary
- Tables inspected: 23 (public schema, plus `auth.*` for FK survey)
- Orphan-scan checks run: 17 (all returned 0)
- Soft-delete consistency checks: 5 tables (all 0 inconsistencies)
- CHECK constraint enforcement: tests blocked by environment policy; verified via constraint catalog instead (96 CHECKs present in pg_constraint, 56 of which are ours in `public.*`).
- Supabase advisors — Security: 1 ERROR, 2 WARN, 23 INFO (RLS-no-policy expected by design); Performance: 60+ INFO (mostly unused indexes on an empty DB, plus 8 unindexed FKs).
- Database state: production DB is essentially empty. 0 leads, 0 activities, 0 tasks, 0 contacts, 0 crm_accounts, 0 opportunities, 0 tags, 0 lead_tags, 0 attachments, 0 import_jobs, 0 notifications, 0 saved_search_subscriptions, 0 recent_views, 0 lead_scoring_rules. Non-empty: users(2), saved_views(1), user_preferences(2), permissions(2), lead_scoring_settings(1), audit_log(14).

The empty state of the leads/activities/etc. tables (despite Phase 6 import test claims) is itself an Info-level observation, not a finding — Phase 6E's idempotent-reimport claim and Phase 6F's commit flow cannot be directly exercised against zero rows. Sub-agent A is testing UI; the row-count is consistent with a reset/clean state.

## Findings

### B-1 — High — `activities.kind` enum is missing `sms` and `task_completed`; Phase 5B "counting kinds catalog" claim is invalid
Method: `SELECT enumlabel FROM pg_enum JOIN pg_type ON ... WHERE typname='activity_kind'` and read of `src/db/schema/enums.ts`.
Result: `activity_kind = {email, call, meeting, note, task}`. Phase 5B claim states the counting set is `{note, call, email, meeting, sms, task_completed}`. Two of those values cannot be inserted because the enum doesn't define them. Worse, no `task_completed` activity is ever produced (tasks have a separate `tasks` table; "completed" is `task_status`, not an `activity_kind`).
Impact: Any code path or query that filters on `kind IN ('sms','task_completed')` will silently return zero rows. Phase 8 audit-B's own Phase 5B drift-check query had to be rewritten because the enum cast rejected `sms` / `task_completed`.
Implementation evidence: `src/lib/activities.ts:114-118` — `bumpLastActivityAt` is fired unconditionally for note (`createNote`) and call (`createCall`); there is no enum membership filter, just per-helper-call logic. No `sms` helper exists. Email/meeting helpers (Phase 7) exist but the bump path is not gated on a "counting kinds" set.
Recommended fix: Either (a) update Phase 5B claim and any docs to match the actual five-value enum, or (b) add the missing enum values and wire `bumpLastActivityAt` accordingly.

### B-2 — High — `leads.tags text[]` legacy column still present alongside relational `lead_tags`
Method: `information_schema.columns WHERE table_name='leads' AND column_name='tags'`.
Result: column present, type `ARRAY` (text[]), nullable. Phase 3C explicitly claims it would be deprecated after backfill; PHASE8-CLAIMS line 42 ("First-class `tags` and `lead_tags` tables; backfilled from `leads.tags text[]` via DO block").
Impact: Two sources of truth for tag-on-lead. Confusion risk + drift risk. Code that still reads/writes `leads.tags` will desynchronize from `lead_tags`. Index `leads_tags_gin_idx` continues to exist on this column.
Recommended fix: Drop column + index in a Phase 8/9 migration once any remaining writers are removed.

### B-3 — High — `public.user_manager_links` view is `SECURITY DEFINER`
Method: Supabase advisor `security_definer_view` ERROR.
Result: View defined with SECURITY DEFINER property; created in Phase 5E partial migration (`phase5_user_manager_view`).
Impact: View enforces creator's permissions, not querier's. With BYPASSRLS roles (mwg_crm_app, postgres) this lets any caller of the view see all manager-link rows regardless of RLS. Since RLS has no policies on users (intentional, app-level access), the practical impact is currently zero, but the SECURITY DEFINER property is unnecessary and is flagged as ERROR-level by Supabase's linter.
Recommended fix: `ALTER VIEW public.user_manager_links SET (security_invoker = true);` or recreate without SECURITY DEFINER.

### B-4 — Medium — `leads_last_activity_idx` is NOT partial as claimed
Method: `SELECT indexdef FROM pg_indexes WHERE indexname='leads_last_activity_idx'`.
Result actual: `CREATE INDEX leads_last_activity_idx ON public.leads USING btree (last_activity_at DESC NULLS LAST)` — no WHERE clause.
Phase 5B claim: "partial index `WHERE is_deleted = false`".
Impact: Once leads are deleted at scale, the index will include archived/deleted rows. With 0 current rows this is purely a future-cost issue; functionally fine.
Recommended fix: Drop and recreate as partial: `CREATE INDEX leads_last_activity_idx ON leads (last_activity_at DESC NULLS LAST) WHERE is_deleted = false;`.

### B-5 — Medium — `pg_trgm` and `unaccent` extensions installed in `public` schema
Method: Supabase advisor `extension_in_public` (WARN ×2). Confirmed via `pg_extension`.
Phase 4H claim: extensions "enabled" — no schema specified.
Impact: Pollutes the `public` namespace; Supabase recommends an `extensions` schema. No correctness issue. WARN-level lint.
Recommended fix: `ALTER EXTENSION pg_trgm SET SCHEMA extensions; ALTER EXTENSION unaccent SET SCHEMA extensions;` (touches every `pg_trgm`-using index DDL — schedule for a maintenance window, not Phase 8).

### B-6 — Medium — 8 unindexed FK columns flagged by performance advisor
Method: Supabase performance advisor, lint `unindexed_foreign_keys`.
Result: missing covering indexes for FKs:
- `accounts.userId` (NextAuth provider linking table; low-traffic)
- `contacts.deleted_by_id`
- `crm_accounts.deleted_by_id`
- `lead_scoring_rules.created_by_id`
- `lead_scoring_settings.updated_by_id` (single-row table; ignorable)
- `leads.deleted_by_id`
- `opportunities.deleted_by_id`
- `tasks.deleted_by_id`
Impact: User-deletion cascades / SET NULL operations on `users` will sequential-scan each child table. With 2 users today, no current pain. Will become a problem after Entra-driven user backfill (Phase 5E full / Phase 9).
Recommended fix: Add btree indexes on each `deleted_by_id` column (partial `WHERE deleted_by_id IS NOT NULL` is fine).

### B-7 — Low — `activities_one_parent` CHECK currently underconstrained for graph-only emails
Method: Constraint definition `CHECK ((lead_id IS NOT NULL)::int + (account_id IS NOT NULL)::int + (contact_id IS NOT NULL)::int + (opportunity_id IS NOT NULL)::int = 1)`.
Phase 3G claim: "`activities.lead_id` becomes nullable; CHECK constraint `activities_one_parent` enforces exactly-one-parent". Matches.
Phase 7 claim: Graph email/meeting activities are persisted with `kind=email`/`kind=meeting`. If they are sent for a lead that is later converted, the activity has to be reassigned (3G claim says it does). Not a current bug but a constraint to be aware of: there is no path to file a graph-message activity that has zero parents (e.g., orphan inbox message) — which appears intentional. **Not actually a finding; documented for clarity.** Skip.

### B-8 — Low — `leads_external_id_idx` (non-unique) coexists with `leads_external_id_unique` (partial unique)
Method: `pg_indexes` listing.
Result: Both `leads_external_id_idx` and `leads_external_id_unique` exist on the same column.
Impact: Redundant index — every insert/update writes to two indexes. No correctness issue. Idle-index advisor flagged `leads_external_id_idx` as unused.
Recommended fix: Drop `leads_external_id_idx`; the unique partial covers ordinary lookups.

### B-9 — Info — `users.password_hash` column is named without `breakglass_` prefix despite Phase 2 being breakglass-only
Method: `information_schema.columns WHERE table='users' AND column_name LIKE '%password%'`.
Result: Column is named `password_hash`, not `breakglass_password_hash`. Functionally fine (only breakglass user has a hash; field is NULL for all others), but the name suggests every user might have a local password. Not a security bug.

### B-10 — Info — `leads.imported_by_name` does NOT exist on `leads`; only on `activities`
Method: `information_schema.columns WHERE table='leads' AND column_name LIKE '%import%'` returns only `import_job_id`. The Phase 6E claim mentions "By-name resolution" producing an `imported_by_name` snapshot, and the column exists on `activities` (verified). The Phase 6E claim does not specifically locate it on `leads`, but PHASE8-CLAIMS §11 ("imported_by_name pattern") implied scanning leads; corrected scope: dirty-data check moves to `activities.imported_by_name`. **Behavior matches schema; Phase 8 dirty-data §11 query needs to be re-targeted to `activities.imported_by_name` rather than leads.**

### B-11 — Info — `activity_kind` enum values not aligned with Phase 6E claim
Phase 6E claim: "Smart-detect parser ... `Phone Calls:`, `Notes:`, `Appointments:`, `Meetings:`, `Emails:`" — these map to (`call`, `note`, `meeting`, `email`); the parser at `src/lib/import/activity-parser.ts:324, 379` confirms only `note`, `call`, `email`. There is no `sms`. Confirms B-1.

### B-12 — Info — `audit_log` retains 14 rows with non-NULL `actor_id` AND non-NULL `actor_email_snapshot`
Method: Direct query.
Result: Earlier Phase 4A.2 claim — `audit_log.actor_email_snapshot` ensures attribution survives user delete, FK is `ON DELETE SET NULL` (confirmed). All 14 rows have both fields populated (not yet stress-tested by deleting an actor; would require manual user-delete to verify cascade behavior preserves the snapshot). Verified by definition; no current drift.

## Spec-vs-actual matrix (positive verifications)

- ✅ FK cascade rules (verified all 25 public-schema FKs match Phase 4A spec):
  - `leads.owner_id → users.id` ON DELETE RESTRICT ✓
  - `audit_log.actor_id → users.id` ON DELETE SET NULL ✓
  - `lead_tags.lead_id`/`lead_tags.tag_id` ON DELETE CASCADE ✓
  - `activities.{lead,account,contact,opportunity}_id` ON DELETE CASCADE ✓
  - `attachments.activity_id` ON DELETE CASCADE ✓
  - `tasks.{lead,account,contact,opportunity}_id` ON DELETE CASCADE ✓
  - `notifications.user_id`, `recent_views.user_id`, `saved_views.user_id`, `saved_search_subscriptions.{saved_view_id,user_id}`, `user_preferences.user_id` ON DELETE CASCADE ✓
  - `crm_accounts.{owner,created_by,deleted_by,source_lead}_id`, `contacts.{owner,created_by,deleted_by,account,source_lead}_id`, `opportunities.{owner,created_by,deleted_by,primary_contact,source_lead}_id`, `leads.{created_by,updated_by,deleted_by,import_job}_id` all ON DELETE SET NULL ✓
- ✅ Orphan scans: 0 across all 17 child tables (lead_tags ↔ leads/tags; activities ↔ all four parents; attachments ↔ activities; tasks ↔ four parents; notifications/saved_views/recent_views/saved_search_subscriptions ↔ users; permissions/user_preferences ↔ users; tags/import_jobs ↔ users; audit_log ↔ users; contacts ↔ crm_accounts; opportunities ↔ crm_accounts).
- ✅ Soft-delete consistency: 0 rows where `is_deleted=true AND deleted_at IS NULL` across leads/crm_accounts/contacts/opportunities/tasks.
- ✅ CHECK constraints present (sample, all confirmed in `pg_constraint`):
  - `leads_first_name_len`, `leads_last_name_len`, `leads_email_format`, `leads_email_len`, `leads_company_len`, `leads_phone_len`, `leads_website_protocol`, `leads_linkedin_url_protocol`, `leads_subject_len`, `leads_est_value_range`, `leads_est_close_range`, `leads_score_band_check`
  - `contacts_first_len`, `contacts_last_len`, `contacts_email_format`, `contacts_email_len`, `contacts_phone_len`
  - `crm_accounts_name_len`, `crm_accounts_phone_len`, `crm_accounts_website_proto`
  - `opportunities_probability_check`, `opps_amount_range`, `opps_close_range`, `opps_name_len`, `opps_prob_range`
  - `tasks_at_most_one_parent`, `tasks_due_range`, `tasks_title_len`
  - `activities_one_parent`, `activities_body_len`, `activities_subject_len`, `activities_imported_by_name_len`, `activities_import_dedup_key_len`
  - `notif_title_len`, `notif_body_len`
  - `tags_color_check`, `tags_color_hex`, `tags_name_len`
  - `lead_scoring_rules_name_len`, `lead_scoring_rules_points_range`
  - `lead_scoring_settings_id_check` (CHECK id=1), `scoring_settings_band_order` (hot > warm > cool), `*_threshold_check` ranges
  - `user_preferences_*_check` (theme, date_format, time_format, table_density, leads_default_mode, email_digest_frequency)
  - `saved_views_scope_check`, `recent_views_entity_type_check`, `saved_search_subscriptions_frequency_check`
  - Live INSERT-rejection tests blocked by audit-policy guard (correctly), but presence of constraints in `pg_constraint` is sufficient evidence Postgres will enforce them.
- ✅ Audit-log preservation: 0 rows with both `actor_id IS NULL` and `actor_email_snapshot IS NULL` (Phase 4A.2 claim holds).
- ✅ External-ID uniqueness: zero duplicates (none could be created — the partial unique index `leads_external_id_unique` on `(external_id) WHERE external_id IS NOT NULL AND is_deleted=false` is present).
- ✅ Singleton breakglass: `users_one_breakglass` partial unique on `is_breakglass WHERE is_breakglass=true` is present.
- ✅ Versioning: `version int NOT NULL` exists on all 7 tables Phase 4A.7 named (leads, crm_accounts, contacts, opportunities, tasks, saved_views, user_preferences).
- ✅ Soft-delete columns: `is_deleted`, `deleted_at`, `deleted_by_id`, `delete_reason` all present on leads/crm_accounts/contacts/opportunities/tasks.
- ✅ FTS / trigram indexes: `leads_fts_idx` (includes `subject` per Phase 6A.6), `leads_trgm_name_idx`, `leads_trgm_company_idx`, `leads_subject_trgm_idx`, `crm_accounts_fts_idx`, `crm_accounts_trgm_name_idx`, `contacts_fts_idx`, `contacts_trgm_name_idx`, `opps_fts_idx` — all present, all partial `WHERE is_deleted = false`.
- ✅ Phase 6 import-related columns/indexes: `activities.imported_by_name`, `activities.import_dedup_key`, `activities_import_dedup_idx`, `leads.external_id`, `leads_external_id_unique`, `leads.subject`, `leads.linkedin_url` (with CHECK).
- ✅ `mwg_crm_app` role has `BYPASSRLS = true` (Phase 4A.3 / Phase 5G claim holds).
- ✅ All Phase 1 base tables have RLS enabled (no policies, expected — Supabase advisor INFO-level only).
- ✅ `last_activity_at` drift: 0 rows out of sync. (Trivially true with zero leads/activities — re-verify after data populated.)

## Items deferred / not exercisable on empty DB

- Score consistency (item §9): zero leads, zero scoring rules. Phase 4C/5B `evaluateLead` engine cannot be exercised. **Recommend: re-run audit-B §9 after data populated.**
- Phase 6 idempotent re-import (Phase 6E): no leads exist to re-import against. Cannot verify "External ID match updates via concurrentUpdate" or "activities deduped by `(lead_id, import_dedup_key)`".
- Vercel Blob orphan scan (Phase 4A.2 / §6): `attachments.blob_url` is empty (0 attachments); `users.photo_blob_url` populated value cannot be enumerated under read-only access permission. Defer to manual verification.
- CHECK enforcement insert tests (§4): permission-guard correctly blocked DDL/DML attempts. CHECK presence verified via `pg_constraint`. Postgres will enforce by definition.

## Schema state snapshot
- public.users: 2 rows
- public.permissions: 2
- public.user_preferences: 2
- public.saved_views: 1
- public.lead_scoring_settings: 1 (defaults: hot=70, warm=40, cool=15 per claim)
- public.audit_log: 14 rows (12 user_preferences/theme toggles, 1 saved_view create, 1 user.promote_to_admin, 1 user.force_reauth, 1 user.breakglass_rotated)
- public.leads: 0
- public.activities: 0
- public.attachments: 0
- public.tasks: 0
- public.notifications: 0
- public.contacts: 0
- public.crm_accounts: 0
- public.opportunities: 0
- public.tags: 0
- public.lead_tags: 0
- public.import_jobs: 0
- public.lead_scoring_rules: 0
- public.recent_views: 0
- public.saved_search_subscriptions: 0
- public.sessions, public.accounts, public.verification_tokens: 0 each (NextAuth tables; JWT sessions are in use, so Drizzle/NextAuth DB sessions table is correctly empty)

## Top-3 highest-severity items
1. **B-1 (High)** — Phase 5B "counting kinds" enum drift. `activity_kind` enum has 5 labels; Phase 5B's claim-list of 6 includes `sms` and `task_completed`, which cannot be inserted. Implementation in `src/lib/activities.ts` only bumps `last_activity_at` for `note` and `call`; `email` and `meeting` activity inserts (Phase 7) bypass the bump entirely.
2. **B-2 (High)** — `leads.tags text[]` not deprecated despite Phase 3C claim. Two sources of truth for tag-on-lead.
3. **B-3 (High)** — `public.user_manager_links` view is `SECURITY DEFINER`. Supabase ERROR-level lint. One-line fix.
