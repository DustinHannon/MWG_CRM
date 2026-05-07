# PLAN-PHASE5.md — MWG CRM Phase 5

> Working checklist. Mirrors the Phase 5 brief.
> Build order is **strict**: 5A must be fully green before any other sub-phase.
> Push direct to `master` after each logical chunk; verify the Vercel deploy succeeds before continuing.
> Migrations apply via Supabase MCP `apply_migration`; run `get_advisors` (security + performance) after each.

> **Status (2026-05-07 1:45pm CDT):**
> - 5A ✅ shipped (push 25a6b0d).
> - 5B ✅ shipped (push d23e163).
> - 5G ✅ partial (xlsx→exceljs + RLS verification shipped; JSDoc long tail deferred).
> - 5E ✅ partial (permission column + user_manager_links view shipped; access-gate update + UI surfaces deferred).
> - 5C, 5D, 5F: deferred. See ROADMAP.md "Phase 5 — what shipped, what's deferred" for the full breakdown and rationale.

---

## Phase 5A — Settings page wiring + Entra photo  *(must finish first)*

### 5A.1 — Audit (`PHASE5-AUDIT.md`)
- [ ] Walk every control on `/settings`. For each: storage column? saved on change? read on load? actually applied?
- [ ] Fill ✅/❌ table for: theme, default landing, default leads view, timezone, date format, time format, table density, 4 notification toggles, email digest frequency, "Sign out everywhere".
- [ ] Document findings in `PHASE5-AUDIT.md`.

### 5A.2 — Theme toggle (most visible)
- [ ] `ThemeControl` calls both `setTheme()` (next-themes) AND `saveThemeAction()` (DB) on every change; reverts visual state on save failure.
- [ ] `<ThemeSync>` client bridge mounted in authenticated layout — fed `prefs.theme` server-side; reconciles next-themes to DB on every mount.
- [ ] Verify cross-device: change in tab A, sign in tab B (different device emulation), pref reflects.

### 5A.3 — Default landing page
- [ ] Save updates `user_preferences.custom_landing_path` (validated against allowlist of internal routes).
- [ ] Allowlist: `/dashboard`, `/leads`, `/tasks`, `/opportunities`, `/accounts`, `/contacts`, plus `/leads?view=<id>` form.
- [ ] `middleware.ts`: if path is `/` and authed, redirect to `custom_landing_path`.

### 5A.4 — Default leads view
- [ ] Save updates `user_preferences.default_leads_view_id` (nullable; FK to `saved_views`).
- [ ] On `/leads` with no `?view=`, the active view selector reads this column. Falls back to built-in `My Open Leads` if null/dangling.

### 5A.5 — Timezone + date/time formats
- [ ] Three columns saved on change: `timezone`, `date_format`, `time_format`.
- [ ] `<UserTime value prefs mode>` server component using `date-fns-tz formatInTimeZone`.
- [ ] Replace every `toLocaleString` / `toISOString` / direct `format(...)` in the UI with `<UserTime>`. Audit list:
  - activity timeline (lead detail)
  - task due dates (tasks list, task detail, dashboard widget)
  - lead created/updated (lead list, lead detail header)
  - last login (user panel, admin users)
  - audit log entries (admin/audit)
  - notification timestamps (notifications page, bell)
  - recent views (Cmd+K, sidebar)
  - "Last sync" on M365 connection card (settings)
- [ ] Relative-time path uses `formatDistanceToNow` (locale-agnostic).

### 5A.6 — Table density
- [ ] Save updates `user_preferences.table_density` (`'comfortable' | 'compact'`).
- [ ] Root authenticated layout reads prefs server-side and sets `data-density="..."` on `<html>`.
- [ ] CSS in `globals.css`:
  ```css
  [data-density="compact"] .data-table tr { height: 36px; }
  [data-density="compact"] .data-table td { padding: 4px 12px; }
  ```
- [ ] Apply `.data-table` className on every data table (leads, accounts, contacts, opportunities, tasks).

### 5A.7 — Notification preferences
- [ ] Each toggle saves on change to its column.
- [ ] **Patch every notification creation site to read recipient prefs first**:
  - `/api/cron/tasks-due-today` → `notify_tasks_due`
  - task-assignment server action → `notify_tasks_assigned`
  - note-create with @-mention → `notify_mentions` per mentioned user
  - `/api/cron/saved-search-digest` in-app → `notify_saved_search`
  - `/api/cron/saved-search-digest` email → `email_digest_frequency`

### 5A.8 — Email digest frequency
- [ ] Dropdown saves on change to `email_digest_frequency` (`'off' | 'daily' | 'weekly'`).
- [ ] Verify saved-search digest cron respects it (existing logic).

### 5A.9 — "Sign out everywhere"
- [ ] Action bumps `users.session_version`.
- [ ] Manual test: open in two browsers; sign out everywhere in one; second is kicked on next request.

### 5A.10 — Entra profile photo
- [ ] Migration `phase5_user_photo_columns`: `users.photo_blob_url text`, `users.photo_synced_at timestamptz` (only if missing).
- [ ] Sign-in flow (Auth.js callbacks): after Graph `/me`, if `photo_synced_at IS NULL OR > 24h ago` then `GET /me/photo/$value`. Upload to Vercel Blob at stable key `users/{user.id}/photo.jpg`. Update `photo_blob_url` and `photo_synced_at`.
- [ ] Failure handling: 404 = INFO log + leave null; 401/403/5xx = WARN log + don't crash sign-in + retry next sign-in.
- [ ] Blob: public-read for these keys; cache-bust URL with `?v={photo_synced_at_unix}`; content-type `image/jpeg`.
- [ ] User panel renders photo when present, initials fallback otherwise.
- [ ] `/settings` profile section renders photo + initials fallback.
- [ ] Test: change photo in Outlook, sign back in, see new photo in app.

### 5A.11 — Push 5A
- [ ] `pnpm tsc --noEmit && pnpm lint && pnpm build` clean.
- [ ] Commit + push to `master`; verify Vercel deploy green.

---

## Phase 5B — Lead scoring completion

### 5B.1 — Activity kind audit
- [ ] Walk every `INSERT INTO activities` in code; classify against the catalog (counting vs non-counting).
- [ ] Add missing enum values via migration if needed: `import`, `bulk_update`, `auto_scored`, `convert`, `archive`, `restore`.
- [ ] Patch any non-human side-effect that uses a counting kind.

### 5B.2 — `last_activity_at` column
- [ ] Migration `phase5_last_activity_at`: `leads.last_activity_at timestamptz`, partial index on `(last_activity_at DESC NULLS LAST) WHERE is_deleted = false`.
- [ ] Backfill: `MAX(activities.created_at)` per lead, restricted to counting kinds only.
- [ ] Activity-insert server action updates `last_activity_at` only when `kind` is counting AND new `created_at` is newer. Imports + non-counting do not touch it.

### 5B.3 — Scoring engine update
- [ ] `evaluateLead` predicate evaluator: `last_activity_within_days` returns false on NULL.
- [ ] Add pseudo-field `has_no_activity` (NULL `last_activity_at`).
- [ ] Engine reads thresholds from new `lead_scoring_settings` table.

### 5B.4 — `lead_scoring_settings` single-row table
- [ ] Migration `phase5_scoring_settings`: single-row table (`CHECK (id = 1)`) with `hot_threshold`, `warm_threshold`, `cool_threshold`, `updated_at`, `updated_by_id`, `version`. Default 70/40/15.

### 5B.5 — `/admin/scoring` UI
- [ ] Section 1 — rules table (active toggle, name, predicate summary, points, created by, edit/delete).
- [ ] Section 2 — threshold sliders (hot/warm/cool), hot > warm > cool enforced UI-side.
- [ ] Section 3 — "Recompute all leads now" button + confirmation modal + sync server action (cap 10k; audit `scoring.recompute_manual`).
- [ ] Rule editor modal: name (required), description, JSON predicate builder reusing saved-views filter component, points -100..+100, active toggle.
- [ ] Server actions: `createScoringRule`, `updateScoringRule` (`concurrentUpdate`), `deleteScoringRule`, `toggleScoringRule`, `updateScoringSettings`. All gated by `requireAdmin`. All audit-logged.

### 5B.6 — `/admin/scoring/help`
- [ ] Static admin-only page documenting field catalog, operator catalog, pseudo-field semantics (especially NULL handling), import-doesn't-count rule, copy-paste examples.

### 5B.7 — Push 5B
- [ ] Verify imported leads get `last_activity_at IS NULL`.
- [ ] Commit + push.

---

## Phase 5C — Phase 4 deferred UIs

### 5C.1 — OCC conflict banner
- [ ] Server action conflict response shape: `{ ok:false, errorCode:'CONFLICT', currentVersion, lastModifiedBy:{name,email}, lastModifiedAt }`.
- [ ] Reusable `<ConflictBanner>` component: refresh (one-more-confirm) / overwrite (re-fetch version, resubmit, audit `record.overwrite_conflict`).
- [ ] Mount on edit forms: `/leads/[id]/edit`, `/opportunities/[id]/edit`, `/accounts/[id]/edit`, `/contacts/[id]/edit`, task edit drawer (if separate).

### 5C.2 — Bulk-tag toolbar UI
- [ ] Row checkboxes on leads table; client-side `Set<string>` selection + URL state via `nuqs` or context.
- [ ] Sticky toolbar when `selected.size > 0`: `Tag…` / `Untag…` / `Export selected` / `Archive selected` / `Clear`.
- [ ] `Tag…` opens existing tag combobox → calls `bulkTagLeads(ids, tagIds, 'add')`.
- [ ] `Untag…` lists tags currently used by ANY selected lead (UNION query) → `bulkTagLeads(ids, tagIds, 'remove')`.
- [ ] `Export selected` triggers existing export with `id IN (...)` filter.
- [ ] `Archive selected`: new `bulkArchiveLeads` server action mirroring `bulkTagLeads` (IDOR + transaction + audit).
- [ ] "Select all matching filter" mode — filter-set selection, server re-runs filter, cap 1000.

### 5C.3 — Drag-and-drop column reorder
- [ ] `@dnd-kit/core` + `@dnd-kit/sortable` already in deps — wire DnD onto leads table column headers.
- [ ] `GripVertical` on header hover; horizontal sortable; drop persists to override (built-in view) or saved view via `concurrentUpdate`.
- [ ] Saved view I don't own: no grip rendered.
- [ ] Keyboard alternative: per-header `…` menu — Move left / right / start / end / Hide.
- [ ] `aria-live` announce on move.
- [ ] `< md` breakpoint: no DnD context, no grip.
- [ ] Verify Save-as-new-view flow still calls `setAdhocColumns(user.id, null)` after capturing reorder.

### 5C.4 — Push 5C
- [ ] Commit + push.

---

## Phase 5D — Forecasting dashboard

### 5D.1 — Aggregation queries
- [ ] One server action returns `{ openPipeline, weightedForecast, closedWonYTD, winRate, monthly[], funnel[], ownerForecast[] }`.
- [ ] Stage-default probability fallback: prospecting 10 / qualification 25 / proposal 50 / negotiation 75 / closed_won 100 / closed_lost 0.
- [ ] In-process 60-second cache.
- [ ] Filter by `owner_id = userId` unless `can_view_all_records`.

### 5D.2 — UI
- [ ] `/dashboard` `<GlassCard weight="1">` Forecast section.
- [ ] KPI strip (4 numbers).
- [ ] Recharts `BarChart` stacked (12 months × stages, weighted amount).
- [ ] Recharts `FunnelChart` (counts at each stage).
- [ ] Owner forecast table when admin.

### 5D.3 — Verify
- [ ] Numbers tie back to opportunity list filters.
- [ ] EXPLAIN ANALYZE on aggregation queries shows index use.

### 5D.4 — Push 5D.

---

## Phase 5E — Manager → CRM user linking

### 5E.1 — Schema
- [ ] Migration `phase5_team_view_perm`: `permissions.can_view_team_records boolean default false`.
- [ ] Migration `phase5_user_manager_view`: `user_manager_links` view joining `users` on `manager_entra_oid = entra_oid`.

### 5E.2 — Access gates
- [ ] Update `requireLeadAccess`, `requireAccountAccess`, `requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess` to allow when `isOnMyTeam(record.owner_id, user.id)` AND user has `can_view_team_records`.

### 5E.3 — UI surfaces
- [ ] `/settings` Profile: render manager as link when `manager_user_id` populated.
- [ ] `/admin/users`: "Reports to" column.
- [ ] `/leads`: built-in view "My team's open leads" when permission granted.
- [ ] `/dashboard` "My open leads" widget: scope toggle Mine / Team / Mine+team.

### 5E.4 — Push 5E.

---

## Phase 5F — Mobile responsiveness pass *(after 5B-5E ship to capture all surfaces)*

### 5F.1 — Approach
- [ ] Desktop-first preserved. Add mobile via `max-md:` overrides per component.
- [ ] Structural changes (sidebar drawer, table → card list) use render branching with `useMediaQuery`, hydration-safe.

### 5F.2 — Components
- [ ] Sidebar → shadcn `<Sheet>` drawer with hamburger. User panel anchored bottom of sheet.
- [ ] Top bar → 56px on mobile, search becomes icon → full-screen overlay.
- [ ] Tables → stacked card list (`<DataCardList>`) for leads/accounts/contacts/opportunities/tasks.
- [ ] Lead detail → single column, right-rail quick-actions become horizontal scroll strip below header.
- [ ] Modals → full-screen on mobile.
- [ ] Pipeline → "Switch to table view" banner on `< md`.
- [ ] Cmd+K → full-screen overlay on mobile.
- [ ] `/settings` → stacked sections; section anchors as horizontal scroll strip.
- [ ] Admin pages → table-to-card pattern.
- [ ] Forecast → KPI strip 2×2; owner table → cards.
- [ ] Forms → full-width inputs; touch targets ≥ 44×44 (`min-h-11 min-w-11`); input font ≥ 16px.

### 5F.3 — QA
- [ ] Real-device QA on iPhone Safari + Android Chrome via Vercel preview.
- [ ] Lighthouse mobile ≥ 90 on `/dashboard`, `/leads`, `/leads/[id]`, `/settings`.
- [ ] No horizontal scroll at 360px on any page.

### 5F.4 — Desktop diff
- [ ] Pre-pass desktop screenshots vs post-pass — should be visually identical.

### 5F.5 — Push 5F.

---

## Phase 5G — Cleanup quick wins

### 5G.1 — RLS service-role verification
- [ ] Grep `createClient(`, `createServerClient(` etc. Confirm server uses service-role key.
- [ ] Document findings in `SECURITY-NOTES.md`.

### 5G.2 — `xlsx` → `exceljs` migration
- [ ] `pnpm add exceljs && pnpm remove xlsx`.
- [ ] Rewrite `src/lib/xlsx-import.ts` and `src/lib/xlsx-template.ts` (and any other `xlsx` consumers) on the exceljs API.
- [ ] Re-import a known sample file end-to-end.
- [ ] `pnpm audit --prod` clean of HIGH.
- [ ] Update `SECURITY-NOTES.md`.

### 5G.3 — JSDoc long tail
- [ ] Every exported function in `src/lib/`.
- [ ] Every server action in `src/app/(app)/**/actions.ts`.
- [ ] Every route handler in `src/app/api/**/route.ts`.
- [ ] Required tags: `@param`, `@returns`, `@throws`, `@actor`.

### 5G.4 — Push 5G.

---

## Phase 5H — Final pass

- [ ] Re-run §2.9 smoke test from Phase 4 against full Phase 5 build.
- [ ] Update `ARCHITECTURE.md` with new tables/columns/permissions/UI surfaces.
- [ ] Update `README.md` Phase 5 section.
- [ ] Post final report in chat with the 15 items from §12 of the brief.
- [ ] Push.

---

## Migration order (apply via Supabase MCP `apply_migration`, run `get_advisors` after each)

1. `phase5_user_photo_columns` (5A.10) — only if columns missing
2. `phase5_last_activity_at` (5B.2) — column + index + backfill
3. `phase5_activity_kind_enum` (5B.1) — only if values missing
4. `phase5_scoring_settings` (5B.4)
5. `phase5_team_view_perm` (5E.1)
6. `phase5_user_manager_view` (5E.1)

## Out of scope (note in `ROADMAP.md` if not already)

- Outlook calendar sync, Outlook add-in
- Custom fields
- Two-way Graph writes
- ML-based scoring
