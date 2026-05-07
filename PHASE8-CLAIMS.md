# Phase 8 — Master Claims Inventory

Every "feature X ships" claim from Phases 1–7 (PLAN, PLAN-PHASE2..7, PHASE4-AUDIT, PHASE5-AUDIT, PHASE6-IMPORT-TEST, PHASE6-OCC-TEST, PHASE7-REPORT, README, ARCHITECTURE). To be evaluated by Phase 8B audit sub-agents A–E.

## Auth + Session
- [Phase 2] Auth.js v5 (`next-auth@beta`) configured with JWT sessions (no DB session lookup per request)
- [Phase 2] Credentials (breakglass) provider with @node-rs/argon2 (argon2id) password hashing
- [Phase 3] MicrosoftEntraID OIDC provider with `signIn` callback enforcing `ALLOWED_EMAIL_DOMAINS` against `email`/`upn` claim
- [Phase 2] Singleton breakglass enforced by partial unique index `users_one_breakglass`
- [Phase 2] Breakglass plaintext password printed once to stderr at cold-start bootstrap, retrievable via `vercel logs`
- [Phase 2B] In-memory rate-limit on breakglass `authorize()`: 5 attempts per username per 15 minutes
- [Phase 4A.4] Breakglass rate-limit hardened: 5/min/IP plus per-username throttle (3/hour)
- [Phase 2B] Session cookie `maxAge = 60 * 60 * 24` set in `src/auth.ts`
- [Phase 4] JWT carries `userId`, `isAdmin`, `email`, `displayName`, `sessionVersion`; every request re-reads `users.session_version` and forces re-auth on mismatch
- [Phase 4] "Sign out everywhere" bumps `users.session_version` and kicks all outstanding JWTs on next request
- [Phase 2B] `safeCallback()` in `src/app/auth/signin/actions.ts` rejects open-redirect callback URLs (same-origin relative only)
- [Phase 3J] Strict CSP with per-request nonces generated in `src/proxy.ts` (replaces static permissive CSP from `next.config.ts`)
- [Phase 3B] Entra provisioning extended via `/me` `$select` (jobTitle, department, officeLocation, businessPhones, mobilePhone, country) plus `/me/manager` call; persists on every sign-in with `entra_synced_at = now()`
- [Phase 5A] Entra profile photo refresh wired into auth jwt callback Case 1 (after `upsertAccount`)
- [Phase 5A] Entra `/me/photo/$value` cached to Vercel Blob at `users/{user.id}/photo.jpg`, 24h TTL, cache-busted by `?v={photo_synced_at_unix}`

## Lead lifecycle
- [Phase 5] Leads CRUD ships (table, filters, search, bulk, create/edit/detail)
- [Phase 2F] Saved views system with view picker, column chooser, "Save as new view" modal
- [Phase 2F] Lead detail provenance line ("Created by [name] on [date]") + "Imported" badge with hover tooltip showing job filename
- [Phase 3F] Duplicate detection on lead create: debounced blur trigger, "View matches" expandable, "Create anyway" audit-logs; endpoint at `/api/leads/check-duplicate`
- [Phase 3F] Import duplicate detection extended to match by normalised phone in addition to email
- [Phase 3G] Lead conversion creates Account + Contact + Opportunity in single transaction; existing activities reassign to new opportunity
- [Phase 3G] Lead detail "Convert" button surfaces conversion modal
- [Phase 4G] Soft delete columns (`is_deleted`, `deleted_at`, `deleted_by_id`, `delete_reason`) on leads/accounts/contacts/opportunities/tasks
- [Phase 4G] Default queries filter `is_deleted=false` via `activeX()` Drizzle helper
- [Phase 4G] Delete button replaced with Archive (sets soft-delete fields; audit `lead.archive`)
- [Phase 4G] `/leads/archived` admin view with Restore + admin-only hard delete with cascade
- [Phase 4G] `/api/cron/purge-archived` daily 10:00 UTC purges archives older than 30 days with row snapshot in `audit_log`
- [Phase 6A] `leads.last_name` nullable; `formatPersonName` helper used at every render site
- [Phase 6A] `leads.subject` column with CHECK constraint; FTS index includes subject
- [Phase 6A] `leads.subject` rendered as italic line under name on detail page; optional column in leads table
- [Phase 6A] `leads.linkedin_url` CHECK constraint enforces `https?://` protocol
- [Phase 6A] `leads.external_id` partial unique index `leads_external_id_unique` for re-import idempotency

## Activities
- [Phase 6] Activities (notes, calls, tasks) ship
- [Phase 3D] @-mentions in notes parsed via `src/lib/mention-parser.ts`; create notifications for mentioned users
- [Phase 3G] `activities.lead_id` becomes nullable; CHECK constraint `activities_one_parent` enforces exactly-one-parent across {lead, account, contact, opportunity}
- [Phase 5B] `last_activity_at` denormalized column on leads, partial index `WHERE is_deleted = false`, kept consistent (only counting kinds; only when newer)
- [Phase 5B] Activity-insert server action updates `last_activity_at` only for counting kinds with newer `created_at`
- [Phase 5B] Counting vs non-counting activity kind catalog enforced; imports + non-counting do not touch `last_activity_at`
- [Phase 6A] `activities.imported_by_name` snapshot column for unresolved By-name references
- [Phase 6A] `activities.import_dedup_key` column + partial index `activities_import_dedup_idx` for idempotent re-imports
- [Phase 7] Microsoft Graph `/me/sendMail` integration sends from user's mailbox, walks Sent Items to fetch back, persists as `kind=email activities` row with `graph_message_id`/`graph_internet_message_id`
- [Phase 7] Inline base64 attachment send capped at 3MB; Graph attachments pulled to Vercel Blob at stable pathname
- [Phase 7] `/me/events` schedule meeting endpoint with attendees, persists as `kind=meeting` activity with `graph_event_id` and `meeting_attendees` jsonb
- [Phase 7] `GraphActionPanel` on `/leads/[id]` with Send email / Schedule meeting tabs, gated by `canSendEmail`/admin, hidden when `do_not_email=true`
- [Phase 7] Token refresh via `getValidAccessTokenForUser(userId)`: rotates within 60s of expiry, throws `ReauthRequiredError` on `invalid_grant`
- [Phase 7] UI "Reconnect Microsoft" button on `ReauthRequiredError` re-runs `signIn("microsoft-entra-id")` with `redirectTo` set to current page

## Tasks + Notifications
- [Phase 3D] `tasks` table with `task_status`, `task_priority` enums; `notifications` table; per-brief indexes
- [Phase 3D] `/tasks` page with list, due-bucket grouping, inline create
- [Phase 3D] Lead detail Tasks tab
- [Phase 3D] Dashboard "My open tasks" KPI card
- [Phase 3D] Notifications bell popover (shadcn Popover) with unread + mark-all-read; full list at `/notifications`
- [Phase 3D] `/api/cron/tasks-due-today` bearer-auth, queries open tasks, creates `task_due` notifications
- [Phase 3D] Cron registered in `vercel.json`; `CRON_SECRET` env var (≥20 chars) added
- [Phase 5A] `tasks-due-today` cron filters via SQL JOIN on `notify_tasks_due` preference
- [Phase 5A] `createTaskAction` reads `notify_tasks_assigned` pref before creating notification
- [Phase 5A] `filterMentionsByPref` called from activities.ts so @-mentions respect `notify_mentions`
- [Phase 6B] `toggleTaskCompleteAction` passes `expectedVersion` to `updateTask`; client task-list-client maintains per-row version map

## Tags
- [Phase 3C] First-class `tags` and `lead_tags` tables; backfilled from `leads.tags text[]` via DO block iterating distinct unnest values
- [Phase 3C] Tag combobox/multiselect with create-on-the-fly (`tag-input.tsx`)
- [Phase 3C] `/admin/tags` admin list with edit color/name + delete
- [Phase 3C] Tags filter on `/leads` is multiselect of existing tag IDs (filter schema migrated to array of tag IDs)
- [Phase 3C] Color tokens added: slate, navy, blue, teal, green, amber, gold, orange, rose, violet, gray
- [Phase 4E] `bulkTagLeadsAction` server action: cap 1000, refuses entire batch on any access failure, transactional ON CONFLICT DO NOTHING / DELETE, audit per lead
- [Phase 6E] Tag autocreate on import: case-insensitive name lookup, missing tags inserted with default color (slate); `(lead_id, tag_id)` inserts into `lead_tags`

## Saved Views + Auto-revert
- [Phase 2F] `saved_views` table with name, is_pinned, scope, filters, columns, sort
- [Phase 2F] `last_used_view_id` persisted to `user_preferences` on view selection
- [Phase 4B] `saveAsNewView` server action inserts into `saved_views` and clears `user_preferences.view_overrides[sourceViewKey]`; audit
- [Phase 4B] Built-in view returns to clean defaults after Save-as-new-view captures current state
- [Phase 5C deferred] DnD column reorder UI deferred (auto-revert backend ships)

## Pipeline (Kanban)
- [Phase 3E] `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` deps installed
- [Phase 3E] `/leads/pipeline` server-rendered shell with DndContext for optimistic status updates
- [Phase 3E] `updateLeadStatus(leadId, newStatus)` server action
- [Phase 3E] `[Table]/[Pipeline]` toggle in leads page header; persists to `user_preferences.leads_default_mode`
- [Phase 3E] `listLeadsForPipeline()` returns grouped-by-status capped per column
- [Phase 3G] `/opportunities/pipeline` Kanban with 6 stages (reuses 3E primitives)

## Cmd+K
- [Phase 3I] `recent_views` table for MRU
- [Phase 3I] Global `<CommandPalette>` mounted once at app shell (`(app)/layout.tsx`)
- [Phase 3I] `/api/search` GET endpoint returning grouped results (leads, contacts, accounts, opportunities, tasks, tags)
- [Phase 3I] Detail pages fire-and-forget upsert into `recent_views` server-side on render (capped to 50)
- [Phase 4H] Cmd+K rewrite uses `websearch_to_tsquery` + similarity union ranking; typo-tolerant

## Lead Conversion
- [Phase 3G] Conversion modal client component
- [Phase 3G] `/leads/[id]/convert/actions.ts` single-transaction conversion
- [Phase 3G] Lead detail "Convert" button surfaces modal
- [Phase 3G] `permissions.can_view_all_leads` renamed to `can_view_all_records`; one flag governs visibility across leads/accounts/contacts/opportunities

## Opportunities
- [Phase 3G] `crm_accounts` (Drizzle alias `crmAccounts`, UI label "Accounts"), `contacts`, `opportunities` tables created with `opportunity_stage` enum
- [Phase 3G] List + detail + new + edit pages for `/accounts`, `/contacts`, `/opportunities`
- [Phase 3G] Sidebar adds Accounts, Contacts, Opportunities entries

## Soft Delete + 30-day Purge
- [Phase 4G] `is_deleted, deleted_at, deleted_by_id, delete_reason` on leads/accounts/contacts/opportunities/tasks with partial indexes
- [Phase 4G] Drizzle `activeX()` helper for default-filtered queries
- [Phase 4G] `/api/cron/purge-archived` daily 10:00 UTC purges archives older than 30 days; snapshot in audit

## Lead Scoring
- [Phase 4C] `lead_scoring_rules` table + `leads.score / score_band / scored_at`
- [Phase 4C] Bands: hot ≥70, warm 40–69, cool 15–39, cold <15
- [Phase 4C] Predicate format mirrors saved-view filter JSON (eq, neq, lt/lte, gt/gte, in, not_in, contains, is_null, is_not_null)
- [Phase 4C] Pseudo-fields `last_activity_within_days` and `activity_count`
- [Phase 4C] `evaluateLead(leadId)` runs on lead create/update, activity create, tag changes
- [Phase 4C] Daily cron `/api/cron/rescore-leads` at 09:00 UTC
- [Phase 4C] `<ScoreBadge>` component for displays
- [Phase 5B] `lead_scoring_settings` single-row table (`CHECK (id = 1)`) with hot/warm/cool thresholds, default 70/40/15
- [Phase 5B] `evaluateLead` predicate evaluator: `last_activity_within_days` returns false on NULL; `has_no_activity` pseudo-field added

## Import
- [Phase 6] 39-column import structure ships
- [Phase 6E] Two-step preview-then-commit flow at `/leads/import` (upload + preview + commit)
- [Phase 6F] `previewImportAction` stream-parses workbook (exceljs), validates Zod, runs activity parser, runs smart-detect if enabled
- [Phase 6F] Preview UI with sections: Records, Activities, Opportunities, Settings (smart-detect toggle), Warnings, Errors
- [Phase 6F] Cached plan keyed by short token, TTL 15min (Vercel Runtime Cache; in-process map fallback)
- [Phase 6F] `commitImportAction(token)` processes in 100-row chunks per transaction; per-chunk error catch
- [Phase 6F] Audit log entry `import.commit` with file name, full preview snapshot, totals, warnings
- [Phase 6C] Multi-line activity parser at `src/lib/import/activity-parser.ts` with bracket-timestamp headers, metadata-line direction/outcome/duration/by-name/attendees, body collection, 200-activity cap with truncation warning
- [Phase 6D] D365 smart-detect parser at `src/lib/import/d365-detect.ts` recognises `Topic:`, `Phone Calls:`, `Notes:`, `Appointments:`, `Meetings:`, `Emails:`, `Linked Opportunity:`, `Description:` section labels
- [Phase 6D] D365 status → opportunity stage mapping (`In Progress` → `prospecting`, `Won` → `closed_won`, etc.); D365 status → lead status mapping
- [Phase 6E] Idempotent re-import: `External ID` match updates via `concurrentUpdate`; activities deduped by `(lead_id, import_dedup_key)`; opportunities skipped if same `source_lead_id + name` exists non-deleted
- [Phase 6E] Owner email resolution: `lower(value)` exact match against `users.email`; no match → row warning + `owner_id = NULL`
- [Phase 6E] By-name resolution: `users.displayName` (case-insensitive) then `firstName + lastName`; no match → `imported_by_name` snapshot
- [Phase 6E] Batch resolution (one query for all owner emails + one for all distinct By-names) avoids N+1
- [Phase 6E] `last_activity_at` recomputed from MAX(activities.occurred_at) where kind in counting set after import; `Last Activity Date` column override only when later
- [Phase 6G] Downloadable .xlsx template at `GET /leads/import/template` with three sheets: Leads (39 headers + 3 example rows), Instructions (column docs + multi-line activity format + status/stage mappings), Allowed values (enum cheat sheet)
- [Phase 6G] Template button placed top-right of `/leads/import`, linked from `/admin/import-help`
- [Phase 5G] `xlsx` migrated to `exceljs` (rewrote `xlsx-import.ts` and `xlsx-template.ts`); `xlsx` removed
- [Phase 4A.3] Import overflow protection: 10k rows max; stream parse; chunk-of-500 transactions; per-row Zod; capped failed-rows list
- [Phase 6I] `/admin/import-help` admin-only static docs page (column docs, multi-line format, mappings, smart-detect, dedup, By-name snapshot)

## Saved-search Subscriptions + Email Digest
- [Phase 3H] `saved_search_subscriptions` table
- [Phase 3H] `saved-search-runner.ts` runs each subscription's filter against records `created_at > last_seen_max_created_at`
- [Phase 3H] `digest-email.ts` renders minimal HTML
- [Phase 3H] `/api/cron/saved-search-digest` bearer-auth daily 14:00 UTC creates in-app notifications and (optionally) emails via Graph from user's own mailbox
- [Phase 3H] Saved view header Subscribe button + manage modal
- [Phase 3H] `/settings → Notifications` lists active subscriptions
- [Phase 5A] Saved-search digest in-app notification respects `notify_saved_search` per-recipient pref
- [Phase 5A] Email digest cron respects `email_digest_frequency` (`off`/`daily`/`weekly`)

## PDF Print
- [Phase 4F] Print stylesheet (Tailwind `print:` + media query) hides chrome, resets glass, sets `@page` margins, hyperlinks rendered with `::after`
- [Phase 4F] `/leads/print/[id]` route outside `(app)` chrome with dense single-column layout (header → details → tags → activities → tasks → files → linked entities → footer)
- [Phase 4F] "Print / Save as PDF" item in lead detail header `…` menu opens `?print=1` in new tab and calls `window.print()`

## CSP
- [Phase 3J] `src/middleware.ts` (Next 16 `proxy.ts`) generates per-request nonce, sets `x-nonce` request header, sets `Content-Security-Policy` response header
- [Phase 3J] Layout reads `headers()` for `x-nonce` and threads to `<Script>` tags via Provider
- [Phase 3J] `style-src 'unsafe-inline'` retained for shadcn/Radix runtime style injection (documented in `SECURITY-NOTES.md`)
- [Phase 3J] Acceptance gate: every page browser console shows zero CSP violations

## Theme + Chrome Consistency
- [Phase 3A] Glass token system: `--glass-1/2/3`, `--glass-border`, `--glass-shadow`, `--glass-blur`, `--glass-saturate`, `--bg-gradient` in `:root` and `.dark`
- [Phase 3A] `<GlassCard weight?>` primitive in `src/components/ui/glass-card.tsx`
- [Phase 3A] Glass surfaces capped at 8 per viewport; form inputs and table cells stay solid
- [Phase 3A] Sidebar shell, topbar, dashboard cards, lead detail panels, modals/popovers wrap in glass
- [Phase 3B] User panel: clickable card with avatar + name + title; popover with Settings + Sign out
- [Phase 3B] `<Avatar>` primitive with photo + initials fallback (deterministic color hash)
- [Phase 3B] Theme toggle moved exclusively to `/settings` (top-bar toggle removed)
- [Phase 5A] Root `<html>` `dark` hardcode removed; `next-themes` `ThemeProvider` mounted in root layout
- [Phase 5A] `<ThemeSync prefs.theme>` client component reconciles next-themes to DB pref on every authed page mount
- [Phase 5A] `<ThemeControl>` calls both `setTheme()` (next-themes) and `saveThemeAction()` (DB) on every change; reverts visual state on save failure
- [Phase 7] Canonical `<AppShell>` extracted at `src/components/app-shell/`: `app-shell.tsx`, `sidebar.tsx`, `top-bar.tsx`, `brand.tsx`, `nav.ts`
- [Phase 7] Both `(app)/layout.tsx` and `admin/layout.tsx` use `<AppShell>`; admin gains glass tokens, notification bell, user panel, Cmd+K palette host
- [Phase 7] Auth gating remains in each layout (`requireSession` / `requireAdmin`); `<AppShell>` is pure renderer
- [Phase 7] Intentional exceptions left outside shell: `/`, `/auth/signin`, `/auth/disabled`, `/leads/print/[id]`

## Server-action Discipline
- [Phase 4A] Every server action takes Zod-validated input
- [Phase 4A] Every mutating action calls `concurrentUpdate` (not bare `db.update`)
- [Phase 4A] Every action gated by `requireXAccess` where it takes an id
- [Phase 4A] Every server action and route handler wrapped in `withErrorBoundary`
- [Phase 4A] Every mutation writes an `audit_log` entry
- [Phase 4A] No `console.log` in committed code (use `logger`); 3 documented boot-path exceptions (`logger.ts`, `env.ts`, `db/index.ts onnotice`)
- [Phase 4A] `KnownError` hierarchy: `ValidationError | NotFoundError | ForbiddenError | ConflictError | RateLimitError`; each carries `publicMessage`
- [Phase 4A] `withErrorBoundary` translates Zod issues into `ValidationError`, logs success/failure with timing, returns `ActionResult<T>` shape
- [Phase 4A] Cron routes return `{ ok, processed, errors }`
- [Phase 4A] Microsoft Graph calls distinguish 401/403/429/5xx and retry transient
- [Phase 4A] Public errors carry `requestId`; stacks never leak in production

## Database Integrity
- [Phase 2C] Single Drizzle migration recreates FKs with rules from §3.1 (cascade/restrict/set null per relationship)
- [Phase 4A] FK cascade rules documented in `ARCHITECTURE.md`; `leads.owner_id` is `ON DELETE RESTRICT`; history columns `ON DELETE SET NULL`; owned children `ON DELETE CASCADE`
- [Phase 4A] CHECK constraints applied for names, emails, urls, dates, numeric values
- [Phase 4A.2] `audit_log.actor_email_snapshot text` added; `actor_id` FK flipped to `ON DELETE SET NULL` so attribution survives user delete
- [Phase 4A.2] Vercel Blob orphan scan compares `blob_url` rows in `attachments` to live Blob store
- [Phase 4A.2] `scripts/orphan-scan.ts` enumerates 16 parent/child relationships and expects zero rows; baseline zero across all
- [Phase 4A.7] `version int NOT NULL DEFAULT 1` on every mutable table: `leads, crm_accounts, contacts, opportunities, tasks, saved_views, user_preferences`
- [Phase 4A.7] `concurrentUpdate` helper at `src/lib/db/concurrent-update.ts` adds `WHERE version = $expected` and bumps in same statement; throws `NotFoundError`/`ConflictError`
- [Phase 6A] `last_name` nullable on leads + contacts; CHECK constraints permit NULL or 1–100 chars
- [Phase 6A] `subject` column on leads with CHECK constraint (NULL or 1–1000 chars); `leads_subject_trgm_idx` GIN trigram partial index
- [Phase 6A] `external_id` partial unique index for re-import idempotency (`WHERE external_id IS NOT NULL AND is_deleted = false`)
- [Phase 5B] `last_activity_at` denormalized column on leads (kept consistent via activity-insert hook for counting kinds with newer timestamps)
- [Phase 4H] `pg_trgm` + `unaccent` extensions enabled
- [Phase 4H] Functional GIN FTS + trigram indexes on `leads`, `crm_accounts`, `contacts`, `opportunities` (typo-tolerant)
- [Phase 6A.6] `leads_fts_idx` rebuilt to include `subject` (alongside first_name/last_name/company_name/email/phone), `WHERE is_deleted = false`
- [Phase 4A] All 10 (Phase 1) tables have RLS enabled with no policies; `mwg_crm_app` role has `BYPASSRLS`
- [Phase 6B] Every edit-form server action calls `concurrentUpdate` (or equivalent versioned UPDATE with `expectAffected`): updateLeadAction, updateTaskAction, toggleTaskCompleteAction, updateViewAction, updatePreferencesAction
- [Phase 6B] Edit forms read `version` from loaded record, carry through state, pass on submit, store new version from action result
- [Phase 6B] `ConflictError` surfaces as toast (`duration: Infinity, dismissible: true`)

## Settings (Phase 5A)
- [Phase 5A] `/settings` six sections: Profile (read-only Entra fields with lock icons + tooltip), Preferences, Notifications, Microsoft 365 connection, Account info, Danger zone
- [Phase 5A] Theme toggle persists to `user_preferences.theme` and applies via next-themes
- [Phase 5A] Default landing page persists to `user_preferences.custom_landing_path`/`default_landing_page`; allowlist enforced via Zod
- [Phase 5A] Default leads view persists to `user_preferences.default_leads_view_id`; honored over `last_used_view_id` when no `?view=` param
- [Phase 5A] Custom landing applied at `/` redirect (proxy or root page)
- [Phase 5A] Timezone, date format, time format toggles apply live via `<UserTime>` server component (date-fns-tz `formatInTimeZone`)
- [Phase 5A] `<UserTime>` rolled out to user-visible timestamp surfaces (settings/account-info, dashboard, leads list/detail/archived, accounts list, opportunities list/detail, notifications/bell, tasks list, audit log, admin users/tags, activity feed, print page)
- [Phase 5A] Table density toggle persists to `user_preferences.table_density`; root layout stamps `data-density` attribute; CSS rules in `globals.css`; `.data-table` className applied across 8 data tables
- [Phase 5A] Notification preference toggles wired: `notify_tasks_due`, `notify_tasks_assigned`, `notify_mentions`, `notify_saved_search`
- [Phase 5A] Email digest frequency dropdown (`off`/`daily`/`weekly`) saves on change; saved-search digest cron respects it
- [Phase 5A] "Sign out everywhere" action bumps `users.session_version`; second browser kicked on next request
- [Phase 5A] Entra profile photo refresh: 404 = INFO log + leave null; 401/403/5xx = WARN log + don't crash sign-in + retry next sign-in
- [Phase 5A] User panel and `/settings` profile section render photo when present, initials fallback otherwise

## Admin
- [Phase 4] `/admin/users` list + detail with permission editing
- [Phase 4] Rotate breakglass password from Admin → Users → breakglass → Rotate (new plaintext shows once in modal)
- [Phase 4] Force re-auth from admin user detail (bumps `session_version`)
- [Phase 9] `/admin/audit` paginated, searchable view of every admin mutation, lead delete, permission change, import; append-only with `before_json`/`after_json` diffs
- [Phase 9] `/admin/data` type-to-confirm flows for delete-all-leads/activities/import-history; cascades via FKs and writes audit row
- [Phase 9] `/admin/settings` read-only env config + Test-Graph button
- [Phase 2F] Admin user delete flow with reassign vs cascade-delete radio; blocks self / breakglass / last-admin; single transaction with Blob cleanup
- [Phase 2F] `/admin/users` lead-count column

## Security headers and validation
- [Phase 2B] `next.config.ts` `securityHeaders` block applied; `productionBrowserSourceMaps: false`, `poweredByHeader: false`
- [Phase 4A.3] `src/lib/validation/primitives.ts` Zod field validators: `nameField`, `emailField`, `phoneField`, `urlField`, `currencyField`, `dateField`, `noteBody`, `tagName`
- [Phase 4A.3] File upload validation at `src/lib/validation/file-upload.ts`: 10MB attachments / 25MB imports cap; MIME allowlist; magic-byte verification (`file-type`); reject executables; sanitize filenames
- [Phase 4A.4] IDOR access gates in `src/lib/access.ts`: `requireLeadAccess`, `requireAccountAccess`, `requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess`, `requireSavedViewAccess`, `requireAttachmentAccess`
- [Phase 4A.4] Each access gate calls `denyAndLog()` writing `access.denied.*` audit event before throwing `ForbiddenError`
- [Phase 4A.4] Vercel Blob private store with short-lived signed URLs gated by `requireAttachmentAccess`
- [Phase 4A.5] Structured JSON logger at `src/lib/logger.ts` with key redaction (`password|token|secret|cookie|...`), levels ERROR/WARN/INFO/DEBUG, request-id middleware
- [Phase 4A.5] Standard meta on log entries: `requestId`, `userId`, `action`, `entityType`, `entityId`, `durationMs`, `errorCode`, `errorMessage` (+ `errorStack` non-prod)
- [Phase 5G] RLS service-role verification documented; server uses service-role key

## Cron jobs registered
- [Phase 3D] `/api/cron/tasks-due-today` daily 14:00 UTC
- [Phase 3H] `/api/cron/saved-search-digest` daily 14:00 UTC
- [Phase 4C] `/api/cron/rescore-leads` daily 09:00 UTC
- [Phase 4G] `/api/cron/purge-archived` daily 10:00 UTC
- [Phase 4A] All cron routes authenticate via `Authorization: Bearer ${CRON_SECRET}`; 401 otherwise; `runtime: 'nodejs'`, `dynamic: 'force-dynamic'`, `maxDuration: 300`

## Schema migrations applied (acceptance evidence)
- [Phase 1] `0000_*.sql` initial schema with `gen_random_uuid()` PKs, timezone-aware timestamps, partial unique indexes for breakglass + Graph dedup
- [Phase 2C] `0001_phase2_integrity.sql` FK rules
- [Phase 2D] `0002_phase2_features.sql` `lead_creation_method` enum, `leads.created_via`, `leads.import_job_id`, `saved_views`, `user_preferences`
- [Phase 3] 8 migrations: phase3_entra_profile_fields, phase3_user_prefs_extension, phase3_tags, phase3_tasks_notifs, phase3_records, phase3_perms_rename, phase3_subscriptions, phase3_recent_views
- [Phase 4] 6 migrations: phase4_db_hardening, phase4_check_constraints, phase4_versioning, phase4_soft_delete, phase4_lead_scoring, phase4_fts_indexes
- [Phase 5] partial: phase5_user_photo_columns, phase5_last_activity_at, phase5_team_view_perm, phase5_user_manager_view (5E partial)
- [Phase 6] 7 migrations: phase6_last_name_nullable, phase6_lead_subject, phase6_lead_linkedin_url_check, phase6_activity_imported_by, phase6_activity_dedup, phase6_fts_subject, phase6_external_id_unique
