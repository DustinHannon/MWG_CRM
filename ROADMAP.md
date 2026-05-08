# MWG CRM — Roadmap

Items deliberately *not* tackled this phase. Re-prioritise from here when planning the next round.

## Security debt

- **Migrate off `xlsx`** (HIGH severity, no npm patch). Candidates: `exceljs`, the SheetJS CDN tarball, or SheetJS Pro. Internal admin-only feature with 10 MB cap mitigates blast radius for now.
- **CSP `style-src 'unsafe-inline'`** — strict CSP with nonces shipped in Phase 3J, but style-src still allows `'unsafe-inline'` because shadcn/Radix and react-hook-form inject styles at runtime. Tightening would require deep framework integration.
- **`'unsafe-eval'` on script-src** — kept for runtime libraries; can probably be removed once we audit which dependency uses eval.
- **Upstash Redis for breakglass rate limit** — current in-memory limiter resets on Vercel cold starts. Acceptable for breakglass (rare use) but not for any future credential endpoint.
- **WebAuthn / passkeys for breakglass** instead of password.
- **CSP violation reporting** — point `report-uri` somewhere so we can see real-world failures.

## Phase 3 follow-ups (intentionally deferred or partial)

- **Saved-view subscribe button on the views toolbar.** Server actions exist (`subscribeToViewAction`, `unsubscribeFromViewAction`); UI integration into `view-toolbar.tsx` and a subscriptions list section in `/settings → Notifications` is incremental work on top.
- **Lead-detail Tasks tab + dashboard "My open tasks" widget.** `/tasks` page is live and tasks attach to leads in the schema; surfacing tasks on the lead-detail page and dashboard is incremental.
- **Lead create/edit form — switch to TagInput.** TagInput component shipped (used in /admin/tags); the create/edit form still uses the legacy `text[]` tags field. Replace and remove `leads.tags text[]` after burn-in.
- **Drop `leads.tags text[]`** once nothing reads it.
- **Import phone-match dedup.** XLSX import already does email-match needs-review; phone-match extension is the same pattern.
- **Account / Contact / Opportunity create + edit pages.** Detail pages are live; entities created via lead conversion. Standalone create/edit forms for these entities are the next surface.
- **Opportunity tabs** (Activities / Contacts / Files / Tasks) — detail page renders a single Details card; activity composer adapter is incremental.
- **Outlook add-in** ("Track this email" button). Deferred — non-trivial.
- **Outlook calendar background sync.** Deferred — out of scope for Phase 3.

## Database performance (Supabase performance advisors)

All currently INFO-level — non-blocking.

- Add covering indexes on FK columns flagged by the linter.
- Drop unused indexes once the workload stabilises.

## RLS

All public tables have RLS enabled with no policies. The app uses a custom Postgres role (`mwg_crm_app`) with `BYPASSRLS`. Defence-in-depth, not the primary access control. If the role is ever changed, RLS becomes a hard wall — desired.

## Phase 4 follow-ups (deferred to a later sprint)

The Phase 4 hardening pass (4A) and most features (4B / 4C / 4E backend / 4F / 4G / 4H) shipped 2026-05-07. Items below are explicitly deferred:

- **4B drag-and-drop column reorder UI** — the auto-revert backend (createViewAction clearing adhoc overrides) is live; the dnd-kit-based column-header drag UI + per-header keyboard-menu alternative are pending.
- ~~**4C `/admin/scoring` admin UI**~~ — **shipped in Phase 5B.**
- **4D Forecasting dashboard** — not yet started. Aggregation queries, Recharts components, owner table.
- **4E bulk-tag selection toolbar** — `bulkTagLeadsAction` server action is live with full IDOR + audit; the leads-table sticky selection toolbar UI is pending.
- **4I Mobile responsiveness pass** — sidebar drawer, card-list tables, full-screen modals, real-device QA. Largest deferred item; deserves its own phase.
- **4J Manager → CRM user linking — partial.** `users_manager_links` view + `can_view_team_records` column landed in Phase 5E. Access-gate update across leads/accounts/contacts/opps/tasks + UI surfaces (settings link to admin user page, /admin/users "Reports to" column, "My team's open leads" view, dashboard scope toggle) still pending.
- **Optimistic-concurrency UI banners** — Phase 6B wired the **backend** OCC across `updateLeadAction`, `updateTaskAction`, `updateViewAction`, `updatePreferencesAction` and the toggle-task-complete path; conflicts now fire a non-auto-dismissing toast. The polished banner with names, "View their changes," and a side-by-side diff is still deferred. Account / contact / opportunity edit-form actions don't exist as separate update flows yet (those entities are view-only); when those forms ship, route them through `concurrentUpdate` from day one.
- **Drag-drop status changes (`updateLeadStatusAction`, `updateOpportunityStageAction`)** — single-field, no row form; OCC threading would require carrying version through the drag event. Acceptable last-write-wins for now; revisit if production data shows actual collisions.
- **Admin "claim/remap imported_by_name to a real user" tool** — Phase 6 stores activity by-names that don't resolve to a CRM user as `activities.imported_by_name`. When the actual person later signs up, an admin needs a small UI to remap historical activities to their new user id. Not built; tracked here.
- **Bulk re-parse legacy D365 dumps** — leads imported before smart-detect existed (or imported with smart-detect off) may still have the D365 dump in `description`. A one-shot admin tool that walks the table, re-parses, and creates the proper structured rows is the cleanest cleanup.
- **Bidirectional Tags / Owner sync against an HR list** — out of scope here; a future integration could keep the CRM users + their owned-leads in line with an authoritative employee directory.
- ~~**`exceljs` migration**~~ — **shipped in Phase 5G.** `pnpm audit --prod` clean of HIGH.

## Phase 5 — what shipped, what's deferred

### Shipped 2026-05-07

- **5A** — Settings page wiring + Entra photo. ThemeProvider + ThemeSync + ThemeControl; Entra photo refresh wired into auth jwt callback; default-landing redirect at `/`; default-leads-view honored in `/leads`; saved-search digest respects `notify_saved_search`; table-density `data-density` attribute + CSS + `.data-table` className across every list; new `<UserTime>` server component + `<UserTimeClient>` + `formatUserTime` rolled out across the user-visible timestamp surfaces.
- **5B** — Lead scoring completion. `lead_scoring_settings` single-row table; engine reads thresholds with 60s in-process cache; `has_no_activity` pseudo-field; activity aggregation restricted to counting kinds explicitly; `createLead` + xlsx-import no longer set `lastActivityAt = now()` (so freshly-created/imported leads have NULL recency and don't game scoring); full `/admin/scoring` UI (rules / sliders / recompute) + `/admin/scoring/help`.
- **5E partial** — `permissions.can_view_team_records` column + `user_manager_links` view applied. Access-gate update + UI surfaces still pending (see 4J entry above).
- **5G partial** — `xlsx → exceljs` migration; RLS service-role usage verified (no `@supabase/supabase-js` clients exist; `postgres-js` direct via privileged role); `pnpm audit --prod` clean.

### Deferred to a follow-up phase

- **5C — Phase 4 deferred UIs.** OCC conflict banner per-form (blocked behind `concurrentUpdate` wiring on lead/account/contact/opp updateX()). Bulk-tag toolbar UI. DnD column reorder UI.
- **5D — Forecasting dashboard.** SQL aggregations + Recharts (KPI strip, stacked bar, funnel, owner table) + permission-scoped data path.
- **5E remainder.** Access-gate team-records check across all 5 entity types. /settings manager-as-link. /admin/users "Reports to" column. "My team's open leads" view. Dashboard "Mine / Team / Both" scope toggle.
- **5F — Mobile responsiveness pass.** `max-md:` overrides per component; sidebar drawer; tables → card list; modals full-screen; pipeline switch-to-table banner; Cmd+K full-screen on mobile; touch target sizing; iPhone Safari + Android Chrome QA; Lighthouse mobile ≥ 90 on the four target pages; desktop visual diff.
- **5G remainder.** JSDoc long tail (every exported `src/lib/` function, every server action, every route handler).

## Phase 6 — what shipped, what's deferred

### Shipped 2026-05-07

- **6A** — Schema migrations: `last_name` nullable on leads + contacts (real CRM data has incomplete name records); `leads.subject` (1-1000 chars) with trgm index, surfaced as italic line under the lead name and included in FTS; `leads.linkedin_url` http/https CHECK; `activities.imported_by_name` snapshot column; `activities.import_dedup_key` partial index; `leads_external_id_unique` partial unique index. `formatPersonName` helper rolled out across every render site that displayed `firstName lastName`.
- **6B** — OCC backend wiring on every edit-form update action: `updateLeadAction`, `updateTaskAction`, `toggleTaskCompleteAction`, `updateViewAction`, `updatePreferencesAction`. `version` round-trips through forms; `ConflictError` surfaces as a `duration: Infinity` toast. `docs/phases/reports/PHASE6-OCC-TEST.md` documents the two-tab smoke test for each path.
- **6C** — Multi-line activity parser (`src/lib/import/activity-parser.ts`): pure function handling calls / meetings / notes / emails with all metadata variants (Duration / Left Voicemail / Status+End+Owner+Attendees / From+To). 200-most-recent cap per cell.
- **6D** — D365 smart-detect (`src/lib/import/d365-detect.ts`): section-aware splitter for the legacy "everything in Description" dump, including the nested `Description:` inside `Linked Opportunity:` blocks. Stage and status mapping in `src/lib/import/stage-mapping.ts`.
- **6E + 6F** — New 39-column import structure with two-step preview-then-commit flow. `previewImportAction` parses, builds aggregate counts/warnings/errors, and stashes the parsed rows under a job id; `commitImportAction` does the chunked write (CHUNK_SIZE=100) using the OCC pattern for re-imports via External ID. Owner emails + activity By-names resolve in two batched queries; tags autocreate; activities dedup via sha256 partial index. Audit log records the full import snapshot.
- **6G** — Downloadable `.xlsx` template with three sheets (Leads / Instructions / Allowed values) and three example rows including a rich row that demonstrates the multi-line activity column shape.
- **6H** — Synthetic-file smoke against `scripts/import-smoke-build.ts` output covering every code path; result captured in `docs/phases/reports/PHASE6-IMPORT-TEST.md`. Production smoke against `mwg-crm-leads-batch-0447.xlsx` requires the file to be placed at `./test-data/` and run by the user.
- **6I** — `/admin/import-help` static reference page; `docs/architecture/ARCHITECTURE.md` / README.md / ROADMAP.md updated.

### Deferred to a follow-up phase

- **OCC conflict banner UI (5C polish, still deferred).** Backend now wired (Phase 6B); the per-form banner with names + "View their changes" remains the polish item.
- **Admin claim-and-remap tool for `activities.imported_by_name`.**
- **Bulk re-parse of legacy D365 dumps still living in `description`.**
- **Production import smoke against `mwg-crm-leads-batch-0447.xlsx`** — tracked in `docs/phases/reports/PHASE6-IMPORT-TEST.md`. Run when the file is available.
- **Account / Contact / Opportunity edit forms** — when those ship, route through `concurrentUpdate` from day one.
