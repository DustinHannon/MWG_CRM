# PLAN-PHASE4.md — MWG CRM Phase 4

> Working checklist. Mirrors the Phase 4 brief. Items get checked off as we land them.
> Build order is **strict**: 4A must be fully green before any feature work starts.
> Push direct to `master` after each logical chunk; verify the Vercel deploy succeeds before continuing.

## Phase 4A — Hardening pass (must finish first)

### 4A.1 — Static audit
- [ ] `pnpm audit --prod` — patch non-breaking, log breaking ones in `SECURITY-NOTES.md` triage
- [ ] `pnpm tsc --noEmit` — zero errors
- [ ] `pnpm lint` — zero errors; fix warnings opportunistically
- [ ] Dead-code scan (manual: grep for unused exports in `src/lib`)
- [ ] Write findings to `PHASE4-AUDIT.md`

### 4A.2 — Database integrity audit
- [ ] FK cascade audit (per the table in the brief). Verify with `pg_constraint` query.
- [ ] `scripts/orphan-scan.ts` — selects every parent/child relationship; expects zero rows.
- [ ] Add `audit_log.actor_email_snapshot text` if missing; flip `actor_id` FK to `ON DELETE SET NULL`.
- [ ] Vercel Blob orphan scan (compare `blob_url` rows in `attachments` to live Blob store).
- [ ] Index review — `pg_stat_user_indexes` for unused; Supabase `get_advisors security` + `performance`.
- [ ] Migration `phase4_fk_audit_fixes` if anything is wrong.

### 4A.3 — Validation primitives + CHECK constraints
- [ ] `src/lib/validation/primitives.ts` — `nameField`, `emailField`, `phoneField`, `urlField`, `currencyField`, `dateField`, `noteBody`, `tagName`.
- [ ] Replace ad-hoc validations across server actions one entity at a time.
- [ ] Migration `phase4_check_constraints` — names/email/url/numeric/date bounds on every entity.
- [ ] File upload validation: 10MB attachments / 25MB imports cap; MIME allowlist; magic-byte verification (`file-type`); reject executables; sanitize filenames.
- [ ] Import overflow protection: 10k rows max; stream parse; chunk-of-500 transactions; per-row Zod; capped failed-rows list.

### 4A.4 — Security pass
- [ ] Auth: domain allowlist confirmed; breakglass rate-limit (5/min/IP, 3/hour/username); session cookie flags; `session_version` check on every request; reject `callbackUrl` open-redirects; logout clears refresh tokens.
- [ ] **IDOR access gates** in `src/lib/access.ts`: `requireLeadAccess`, `requireAccountAccess`, `requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess`, `requireSavedViewAccess`, `requireAttachmentAccess`. Every server action that takes an id calls one.
- [ ] Injection audit: no `sql.raw(` with user input; `dangerouslySetInnerHTML` only after `isomorphic-dompurify`; URL render goes through validator; CSRF intact.
- [ ] Sensitive data exposure: no token-printing console logs; opaque error responses with `requestId`; DB error messages never leak; security headers in `next.config.ts`; CSP zero violations.
- [ ] Vercel Blob: private store with short-lived signed URLs gated by `requireAttachmentAccess`.

### 4A.5 — Structured logger
- [ ] `src/lib/logger.ts` with `redact` + level + JSON-line format.
- [ ] Replace `console.{log,error,warn}` everywhere committed.
- [ ] Standard meta: `requestId`, `userId`, `action`, `entityType`, `entityId`, `durationMs`, `errorCode`, `errorMessage` (+ `errorStack` non-prod).
- [ ] Request-id middleware (Next.js `headers()` thread or AsyncLocalStorage).

### 4A.6 — withErrorBoundary + KnownError hierarchy
- [ ] `src/lib/server-action.ts` — `withErrorBoundary`, `KnownError` base + `ValidationError`, `NotFoundError`, `ForbiddenError`, `ConflictError`, `RateLimitError`.
- [ ] Wrap every server action and route handler in `withErrorBoundary`.
- [ ] Cron routes return `{ ok, processed, errors }`.
- [ ] Microsoft Graph calls — distinguish 401/403/429/5xx; retry transient.

### 4A.7 — Optimistic concurrency
- [ ] Migration `phase4_versioning`: `version int NOT NULL DEFAULT 1` on `leads, accounts, contacts, opportunities, tasks, saved_views, user_preferences`.
- [ ] `src/lib/db/concurrent-update.ts` helper.
- [ ] Forms read `version` and POST it back; `ConflictError` UI banner with "View their changes / Discard yours".
- [ ] Document append-only / safe-LWW exceptions in `ARCHITECTURE.md`.

### 4A.8 — Documentation
- [ ] `ARCHITECTURE.md` — system diagram, data model, auth flow, cron stack, Graph integration, concurrency model, logging, design decisions.
- [ ] Append to `SECURITY-NOTES.md` — audit findings, accepted risks, attachment access flow, CSP, IDOR gate pattern.
- [ ] JSDoc on exported `src/lib`, `src/server`, `src/app/api` functions (`@param`, `@returns`, `@throws`, `@actor`).

### 4A.9 — Smoke test + push
- [ ] Orphan scan returns zeros.
- [ ] Garbage SQL inserts rejected by CHECK.
- [ ] Two-tab concurrency conflict banner.
- [ ] `pnpm build` clean; CSP zero violations.
- [ ] Vercel deploy green; summary in `PHASE4-AUDIT.md`.

---

## Phase 4B — View management improvements

- [ ] Normalize `column_config` to ordered array shape (migration if required).
- [ ] `saveAsNewView` server action: insert into `saved_views`; clear `user_preferences.view_overrides[sourceViewKey]`; audit.
- [ ] Drag-and-drop column reorder using `@dnd-kit`; persists to override (built-in) or row (saved view) via `concurrentUpdate`.
- [ ] Keyboard alternative: per-header `…` menu with Move left / right / start / end / Hide. `aria-live` announce.
- [ ] Mobile (`< md`): no grip icons; no dnd context.
- [ ] Mirror to `/accounts`, `/contacts`, `/opportunities` if saved views exist there; otherwise note in `PHASE4-AUDIT.md`.

## Phase 4C — Lead scoring (rules-based)

- [ ] Migration `phase4_lead_scoring`: `lead_scoring_rules` table + `leads.score / score_band / scored_at`.
- [ ] Bands: `hot` ≥70, `warm` 40–69, `cool` 15–39, `cold` <15.
- [ ] Predicate format mirrors saved-view filter JSON; ops: eq, neq, lt/lte, gt/gte, in, not_in, contains, is_null, is_not_null; pseudo-fields like `last_activity_within_days`.
- [ ] `src/lib/scoring/engine.ts` — `evaluateLead(leadId)`; runs on lead create/update, activity create, tag changes.
- [ ] Cron `/api/cron/rescore-leads` daily 09:00 UTC.
- [ ] `/admin/scoring` admin page — rule list + filter-builder + threshold sliders + "Recompute all".
- [ ] Lead detail badge; lead list/Kanban band column; dashboard donut widget.

## Phase 4D — Forecasting dashboard

- [ ] Aggregation queries (server-side SQL): `Open pipeline`, `Weighted forecast`, `Closed won YTD`, `Win rate`.
- [ ] Recharts components: KPI strip, stacked bar (months × stages), funnel, owner table.
- [ ] Permission scope: `can_view_all_records` sees org; otherwise scoped to own records.
- [ ] Light/dark glass theme verified.

## Phase 4E — Bulk tag operations

- [ ] Sticky toolbar on `/leads` when selection non-empty.
- [ ] `bulkTagLeads(leadIds, tagIds, operation)` — cap 1000; `requireLeadAccess` for every id; single transaction; `ON CONFLICT DO NOTHING` on adds; audit per lead.

## Phase 4F — Print / Save-as-PDF

- [ ] Print stylesheet (Tailwind `print:` + media query). Hide chrome; reset glass; `@page` margins; hyperlink `::after`.
- [ ] `/leads/[id]?print=1` dense single-column layout (header → details → tags → activities → tasks → files → linked entities → footer).
- [ ] "Print / Save as PDF" item in lead detail header `…` menu — opens `?print=1` in new tab and calls `window.print()`.

## Phase 4G — Soft delete

- [ ] Migration `phase4_soft_delete` — `is_deleted, deleted_at, deleted_by_id, delete_reason` on `leads, accounts, contacts, opportunities, tasks` + partial indexes.
- [ ] Drizzle helper `activeX()` for default-filtered queries.
- [ ] Replace Delete button with Archive (sets soft-delete fields; audit `lead.archive`).
- [ ] `/leads/archived` admin view + Restore + admin-only hard delete with cascade.
- [ ] Cron `/api/cron/purge-archived` daily 10:00 UTC — purge archives older than 30 days; snapshot in audit.

## Phase 4H — Full-text search

- [ ] Migration `phase4_fts_indexes` — `pg_trgm` + `unaccent` extensions; functional GIN on `to_tsvector('english', ...)`; trigram GIN on name/company; mirror to accounts/contacts/opportunities.
- [ ] Query rewriter using `websearch_to_tsquery` + similarity union; `LIMIT 10` final.
- [ ] Replace ILIKE in Cmd+K, leads quick-filter.
- [ ] Keep duplicate detection exact (email/phone) + add fuzzy "similar names" suggestion.

## Phase 4I — Mobile responsiveness

- [ ] Sidebar → `<Sheet>` drawer on `< md`; top bar 56px tall; user panel anchored in drawer bottom.
- [ ] Tables → stacked card lists `< md`.
- [ ] Lead detail single column `< md`; tabs into bottom switcher.
- [ ] Modals full-screen `< md`.
- [ ] Pipeline shows "Switch to table" banner `< md`.
- [ ] Cmd+K full-screen on mobile.
- [ ] `/settings` rail+content collapses to stack.
- [ ] Touch targets ≥ 44×44; inputs ≥ 16px font-size; no horizontal scroll at 360px.
- [ ] Real-device QA on iOS Safari + Android Chrome via Vercel preview.
- [ ] Lighthouse mobile ≥ 90 (Performance, Accessibility, Best Practices, SEO).

## Phase 4J — Manager linking

- [ ] Migration `phase4_team_view_perm` — `permissions.can_view_team_records boolean default false`.
- [ ] Migration `phase4_user_manager_view` — `user_manager_links` view.
- [ ] Update access gates: `isOnMyTeam` via `isReportToMe` query.
- [ ] Settings → Manager field renders as link when `manager_user_id` exists.
- [ ] Admin → Users column "Reports to".
- [ ] Leads list "Team" view when `can_view_team_records`.
- [ ] Dashboard "My open leads" Mine / Team / Mine+team toggle.

## Phase 4K — Final pass + report

- [ ] Re-run §2.9 smoke test on full build.
- [ ] Update `ARCHITECTURE.md` with new tables/cron/permissions.
- [ ] Update `README.md` Phase 4 section.
- [ ] Post final report in chat with the 15 items from §15 of the brief.

---

## Migration order (apply via Supabase MCP `apply_migration`, run `get_advisors` after each)

1. `phase4_check_constraints` (4A.3)
2. `phase4_versioning` (4A.7)
3. `phase4_audit_actor_snapshot` (4A.2)
4. `phase4_column_config_shape` (4B; only if needed)
5. `phase4_lead_scoring` (4C)
6. `phase4_soft_delete` (4G)
7. `phase4_fts_indexes` (4H)
8. `phase4_team_view_perm` (4J)
9. `phase4_user_manager_view` (4J)

## Deferrals (note in ROADMAP.md)

- Outlook calendar sync via Graph `/me/calendarView` — future phase.
- Server-side PDF rendering (puppeteer / @react-pdf/renderer) — only revisit if automated PDF generation is needed.
