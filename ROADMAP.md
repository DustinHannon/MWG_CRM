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
- **Optimistic-concurrency UI banners** — backend `concurrentUpdate` rejects with `ConflictError`; lead detail / opportunity edit forms still need the per-form "View their changes / Discard yours" banner. (Note: as of Phase 5B audit, the lead/account/contact/opp `updateX()` paths don't actually call `concurrentUpdate` yet — wiring them through is a prerequisite to the banner. Scoring rules + scoring settings already use the pattern.)
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
