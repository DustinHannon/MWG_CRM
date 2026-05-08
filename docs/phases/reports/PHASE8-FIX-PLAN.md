# Phase 8 — Fix Plan

Total fixes scheduled this phase: 23
Total deferred: 6 (with reasons)
Total not-a-bug / pass-through: F-049 to F-052, F-054 covered by other fixes.

Estimated effort (rough): 9×S + 11×M + 3×L ≈ 4.5h S + 22h M + 24h L = ~50 person-hours total. Actual elapsed depends on parallelism (see waves).

Severity coverage scheduled this phase:
- Critical: 1/1 (F-001)
- High: 10/10 (F-002 through F-011, F-012)
- Medium: most (15/18; 3 deferred — see below)
- Low: 6/16 (one-line safety tweaks; rest deferred)
- Info: 1/6 (CI guard for RLS policy presence)

---

## Fixes scheduled

### FIX-001 — Bind `urlField`/`nameField` primitives to lead/account/contact/opportunity schemas + import row schema
Covers: F-001, F-010
Severity: Critical / High
Files:
- `src/lib/leads.ts` (replace `z.string().url()` with `urlField`; replace name fields with `nameField`)
- `src/lib/import/row-schema.ts` (firstName/lastName/companyName/jobTitle/industry → `nameField`; website → `urlField`)
- `src/db/schema/leads.ts` zod-side equivalents if present (verify)
- accounts/contacts/opportunities equivalent server-side schemas (grep `z.string().url(`)
- `src/lib/validation/primitives.ts` (verify `urlField`/`nameField`/`tagName` present; no change expected)
Effort: S
Parallel-safe with: FIX-002 (different scope unless they overlap on actions wrapper integration — keep schemas pure)

### FIX-002 — Adopt `withErrorBoundary` + `ActionResult<T>` across all server actions
Covers: F-002, F-020, F-022, F-023, F-039, F-001 (CHECK→ValidationError translation)
Severity: High
Files:
- `src/lib/server-action.ts` (add PG SQLSTATE 23514 → ValidationError translation; add `requestId` propagation)
- Every `src/app/**/actions.ts` (38 files) — wrap each exported action body
- Every `src/components/**/actions.ts` (tags/notifications)
- `src/lib/errors.ts` (ensure all needed KnownError subclasses exist)
Effort: L (single-day refactor; touches every actions.ts)
Parallel-safe with: NONE (touches almost every actions.ts — must serialize OCC fixes after this)

### FIX-003 — Add OCC to lead pipeline kanban DnD
Covers: F-006, F-046
Severity: High
Files:
- `src/app/(app)/leads/pipeline/actions.ts` (use `updateLead(user, leadId, expectedVersion, { status })`)
- `src/app/(app)/leads/pipeline/*.tsx` (kanban card — thread `version` through hidden form field)
- `src/lib/leads.ts` (verify `updateLead` WHERE includes `is_deleted = false`; if not, add — addresses F-046)
Effort: M
Parallel-safe with: FIX-004 (different table); FIX-007 (import) on commit.ts only after FIX-002 lands

### FIX-004 — Add OCC to opportunity pipeline kanban DnD
Covers: F-005
Severity: High
Files:
- `src/app/(app)/opportunities/pipeline/actions.ts` (call `concurrentUpdate({ table: opportunities, id, expectedVersion, patch })`)
- `src/app/(app)/opportunities/pipeline/*.tsx` (kanban card — thread `version`)
Effort: M
Parallel-safe with: FIX-003 (disjoint files), FIX-007

### FIX-005 — Fix CSP nonce on `next-themes` ThemeProvider (root layout)
Covers: F-003
Severity: High
Files:
- `src/app/layout.tsx` (or wherever ThemeProvider mounts) — read `headers().get('x-nonce')`, pass `<ThemeProvider nonce={nonce}>`
- `src/components/theme/theme-provider.tsx` (accept and forward `nonce` prop if not already)
Effort: S
Parallel-safe with: FIX-006 (different file), FIX-001, FIX-004, FIX-003

### FIX-006 — Fix CSP nonce on lead print page auto-print script
Covers: F-004, F-054
Severity: High
Files:
- `src/app/leads/print/[id]/page.tsx` (read `x-nonce` via `headers()`, apply `nonce={nonce}` to `<script>`; OR convert to client-component `useEffect`)
Effort: S
Parallel-safe with: FIX-005, FIX-001, FIX-003, FIX-004

### FIX-007 — Fix import UPDATE silent-no-op + non-versioned `lastActivityAt` patch
Covers: F-007, F-027
Severity: High
Files:
- `src/lib/import/commit.ts` (replace bare update with `concurrentUpdate(...)`; fold `lastActivityAt` into main UPDATE statement)
Effort: M
Parallel-safe with: FIX-003, FIX-004 (different dirs); MUST run after FIX-002 (uses error-boundary translation)

### FIX-008 — Fix `cancelImportAction` ownership check on DB update
Covers: F-008
Severity: High
Files:
- `src/app/(app)/leads/import/actions.ts` (add `eq(importJobs.userId, user.id)` to WHERE; admin override OK)
Effort: S
Parallel-safe with: FIX-007 (touches `commit.ts`, this touches `actions.ts` — disjoint within import dir)

### FIX-009 — Wire magic-byte validation into import preview path
Covers: F-009
Severity: High
Files:
- `src/app/(app)/leads/import/actions.ts` (call `validateAttachment` or import-specific variant before `parseWorkbookBuffer`; replace inline 10MB literal with `MAX_IMPORT_BYTES` — this addresses F-026 too)
- `src/lib/validation/file-upload.ts` (add an `validateImportFile` variant if pure variant required)
Effort: S
Parallel-safe with: FIX-007 (commit.ts), FIX-008 (actions.ts only ~50 lines apart but same file — must serialize within FIX-008)
NOTE: Combine FIX-008 and FIX-009 into single PR since both touch `import/actions.ts`.

### FIX-010 — Fix `activity_kind` enum drift (claim-side reconciliation)
Covers: F-011
Severity: High
Files:
- `PLAN-PHASE5.md` / `PHASE8-CLAIMS.md` (update Phase 5B "counting kinds" claim to reflect actual 5-value enum {email, call, meeting, note, task})
- `src/lib/activities.ts` (verify `bumpLastActivityAt` fires on email/meeting helpers; add if missing — Phase 7 helpers may bypass)
Effort: S (claim-side); M if migration to add `sms`/`task_completed` is preferred (skip — defer; Phase 5B doc fix is simpler)
Parallel-safe with: ALL except FIX-002

### FIX-011 — Drop `leads.tags text[]` legacy column + GIN index after grep-confirming no writers
Covers: F-012
Severity: High
Files:
- Grep src for `leads.tags` writes / `leads_tags_gin_idx` references
- Migration: `DROP INDEX leads_tags_gin_idx; ALTER TABLE leads DROP COLUMN tags;`
- `src/db/schema/leads.ts` (remove the column from Drizzle schema)
- Generate updated TS types via Supabase MCP
Effort: M (verify no readers, write migration, regenerate types)
Parallel-safe with: most others; serialize against any unrelated leads schema migration

### FIX-012 — Fix `user_manager_links` view SECURITY DEFINER → invoker
Covers: F-013
Severity: Medium
Files:
- New Supabase migration: `ALTER VIEW public.user_manager_links SET (security_invoker = true);`
Effort: S
Parallel-safe with: ALL (DDL-only, no app-code touches)

### FIX-013 — Recreate `leads_last_activity_idx` as partial WHERE `is_deleted = false`
Covers: F-014
Severity: Medium
Files:
- Migration: `DROP INDEX leads_last_activity_idx; CREATE INDEX leads_last_activity_idx ON leads (last_activity_at DESC NULLS LAST) WHERE is_deleted = false;`
Effort: S
Parallel-safe with: ALL (DDL only)

### FIX-014 — Add btree partial indexes for 8 unindexed FK columns
Covers: F-016
Severity: Medium
Files:
- Migration: `CREATE INDEX CONCURRENTLY ... WHERE <fk> IS NOT NULL` × 8 (accounts.userId, contacts.deleted_by_id, crm_accounts.deleted_by_id, lead_scoring_rules.created_by_id, lead_scoring_settings.updated_by_id, leads.deleted_by_id, opportunities.deleted_by_id, tasks.deleted_by_id)
Effort: S
Parallel-safe with: ALL (DDL only)

### FIX-015 — Add Subject input to lead form
Covers: F-017
Severity: Medium
Files:
- `src/app/(app)/leads/lead-form.tsx` (add `<textarea name="subject" maxLength={1000}>` in Notes section)
- `src/lib/leads.ts` (verify `subject` field present in create/update Zod schema; add if missing)
Effort: S
Parallel-safe with: FIX-016 (same file — combine)

### FIX-016 — Replace comma-separated tags input with `<TagInput>` combobox on lead form
Covers: F-018
Severity: Medium
Files:
- `src/app/(app)/leads/lead-form.tsx` (replace plain Input with `<TagInput>` import from `src/components/tags/tag-input.tsx`)
- `src/lib/leads.ts` (adapt schema if input format changes — likely already accepts string array)
Effort: S
Parallel-safe with: FIX-015 — COMBINE into single PR (both touch `lead-form.tsx`).

### FIX-017 — Add Vercel Blob cleanup to hard-delete and purge-archived cron
Covers: F-024
Severity: Medium
Files:
- `src/app/(app)/leads/actions.ts:hardDeleteLeadAction` (gather blob paths before DB delete; `void cleanupBlobsForLead(...).catch(log)` outside transaction)
- `src/app/api/cron/purge-archived/route.ts` (same pattern in cron loop)
- `src/lib/leads.ts` (helper `cleanupBlobsForLead` if not already present — model after `cleanupBlobsForUser` in `delete-user-actions.ts:182-205`)
Effort: M
Parallel-safe with: most others; serialize against any other change to those two files

### FIX-018 — Apply `tagName` primitive to import tag autocreate + `getOrCreateTagAction`
Covers: F-025, F-038
Severity: Medium / Low
Files:
- `src/lib/import/commit.ts` (apply `tagName.safeParse(trimmed)` per tag in `ensureTags`, surface as row warning, skip)
- `src/components/tags/actions.ts` (apply `tagName` to `getOrCreateTagAction` input)
Effort: S
Parallel-safe with: FIX-007 (also touches `commit.ts` — must serialize after FIX-007)

### FIX-019 — Bulk audit insert in `bulkTagLeadsAction`
Covers: F-021
Severity: Medium
Files:
- `src/components/tags/actions.ts` (replace per-lead writeAudit loop with single `db.insert(auditLog).values([...])` of all rows)
Effort: S
Parallel-safe with: FIX-018 (same file — combine into single PR)

### FIX-020 — Sanitize `String(err)` in `import_jobs.errors`
Covers: F-023
Severity: Medium
Files:
- `src/app/(app)/leads/import/actions.ts` (replace `String(err)` with generic public message; full err via `logger.error`)
Effort: S
Parallel-safe with: FIX-008, FIX-009 (same file — COMBINE all three).

### FIX-021 — Cron endpoints return clean 401 (proxy bypass)
Covers: F-033
Severity: Low
Files:
- `src/proxy.ts` (add `/api/cron/` to `PUBLIC_PATH_PREFIXES`)
Effort: S
Parallel-safe with: ALL

### FIX-022 — Update activity-feed empty-state copy and "Delete" button label
Covers: F-031, F-032
Severity: Low
Files:
- `src/app/(app)/leads/[id]/activities/activity-feed.tsx:37` (drop "arrive in Phase 7")
- `src/app/(app)/leads/[id]/page.tsx:161` (rename "Delete" to "Archive")
Effort: S
Parallel-safe with: ALL

### FIX-023 — Drop redundant `leads_external_id_idx`
Covers: F-034
Severity: Low
Files:
- Migration: `DROP INDEX leads_external_id_idx;`
Effort: S
Parallel-safe with: FIX-013, FIX-014 (DDL only — bundle into a single index-cleanup migration)

---

## Fix waves (execution order)

### Wave 1 — pure DDL migrations (parallel-safe; no app-code dependency)
Bundle into one Supabase migration to minimize round-trips:
- FIX-012 (security_invoker on user_manager_links view)
- FIX-013 (partial index on leads_last_activity_idx)
- FIX-014 (8 unindexed FK partial indexes)
- FIX-023 (drop redundant leads_external_id_idx)
Total effort: 1×S (combined ≤ 30 min). Can run while app-code work proceeds.

### Wave 2 — pure schema/UI primitives + isolated single-file fixes (parallel-safe; no overlap with each other)
- FIX-001 (validation primitives — touches schemas, not actions wrappers)
- FIX-005 (CSP nonce in root layout / theme-provider)
- FIX-006 (CSP nonce on print page)
- FIX-021 (cron public-paths in proxy.ts)
- FIX-022 (string-only edits in activity-feed.tsx and lead detail page.tsx)
- FIX-010 (Phase 5B claim doc + verify activities.ts bump helpers)
Total effort: 6 single-file/single-doc edits, all S-tier. Can run in parallel.

### Wave 3 — adopt `withErrorBoundary` (single large refactor; serialize)
- FIX-002 (touches ~38 actions.ts files; serialise to avoid merge churn)
Total effort: 1×L. Single developer/agent should own this; don't parallelize.

### Wave 4 — concurrency + import fixes that depend on Wave 3 (serialize on shared files)
- FIX-003 (lead pipeline OCC) — touches `pipeline/actions.ts`
- FIX-004 (opportunity pipeline OCC) — touches different `pipeline/actions.ts`; PARALLEL with FIX-003
- FIX-007 (import commit OCC + lastActivityAt) — touches `commit.ts`
Total effort: 2×M plus 1×M; FIX-003 and FIX-004 are parallel; FIX-007 is parallel-safe with both (different file).

### Wave 5 — combined import-actions.ts changes (single file, serialise)
- FIX-008 + FIX-009 + FIX-020 (all three touch `src/app/(app)/leads/import/actions.ts`) — bundle into one PR.
Total effort: 1×M (combined).

### Wave 6 — combined lead-form.tsx changes (single file, serialise)
- FIX-015 + FIX-016 (both touch `lead-form.tsx`) — bundle into one PR.
Total effort: 1×S–M.

### Wave 7 — combined tags/actions.ts changes (single file, serialise)
- FIX-018 (tagName on import + on getOrCreateTagAction) — touches `commit.ts` AND `tags/actions.ts`; the `commit.ts` part must serialise after FIX-007
- FIX-019 (bulk audit) — touches `tags/actions.ts`; combine with FIX-018's `tags/actions.ts` half.
Total effort: 1×S.

### Wave 8 — schema migration with code dependency
- FIX-011 (drop `leads.tags` column + GIN index): grep for writers first; remove writers; DDL last; regenerate Drizzle types. Single track.
- FIX-017 (Vercel Blob cleanup on hard-delete and purge cron): touches `leads/actions.ts`, `cron/purge-archived/route.ts`, `lib/leads.ts`. Parallel-safe with FIX-011.
Total effort: 1×M + 1×M; parallel.

---

## Deferred from this phase

### DEFER-001 — Move `pg_trgm` and `unaccent` extensions out of `public` schema
Source: F-015 (B-5)
Reason: `ALTER EXTENSION ... SET SCHEMA extensions` touches every `pg_trgm`-using index DDL — schedule for a maintenance window with full DB freeze. Not appropriate for a Phase 8 cleanup pass.
Recommended next phase: Phase 9 maintenance window or dedicated migration window.

### DEFER-002 — Implement Vercel Runtime Cache for import-job cache
Source: F-053 (E-I-5)
Reason: Currently single-region deploy; impact is theoretical until multi-region scaling. Implementation is a non-trivial wiring exercise. Cheaper alternative: update Phase 6F claim text to "in-process only" and revisit when multi-region planned.
Recommended next phase: Phase 9 or whenever multi-region is on the roadmap.

### DEFER-003 — Hash full body in activity dedup-key (vs. first 200 chars)
Source: F-028 (E-I-9)
Reason: Edge-case false-positive dedup; probability low for D365 dumps. Changing the hash invalidates every existing `import_dedup_key` value, requiring backfill migration. Not justified until a real conflict surfaces.
Recommended next phase: revisit if telemetry shows a real-world dedup collision.

### DEFER-004 — Replace `resolveByNames` full-table scan with WHERE filter
Source: F-030 (E-I-10)
Reason: Acceptable at current scale (~50 users). Optimization premature.
Recommended next phase: Phase 9 once user count > 500.

### DEFER-005 — Choose one of `lib/access.ts` vs `lib/auth-helpers.ts`; migrate audit-on-deny
Source: F-048 (C-2)
Reason: Migration to `access.ts` everywhere is invasive (touches every gated action), and the current `auth-helpers.ts` flavor is functionally correct. The audit-on-deny missed feature is the only behavioural gap; acceptable until a security review explicitly demands deny-logging.
Recommended next phase: Phase 9 architecture cleanup, or whenever deny-logging is required.

### DEFER-006 — Add `x-vercel-cron-signature` defense in depth on cron routes
Source: F-042 (C-15)
Reason: Bearer token is functionally correct; defense-in-depth only matters if `CRON_SECRET` leaks. Not a current vulnerability.
Recommended next phase: Phase 9 hardening.

### DEFER-007 — `searchTagsAction` per-user filtering
Source: F-038 (C-18) — partial. Length/charset gate on `getOrCreateTagAction` is in FIX-018; the per-user filter half is intentional (tags are org-shared by design) and not a bug.
Reason: schema doesn't partition by user; per-user filtering would be a feature change.

### DEFER-008 — `disconnectGraphAction` before-snapshot in audit
Source: F-043 (C-8)
Reason: nice-to-have audit improvement; current behaviour is idempotent and not security-relevant.
Recommended next phase: Phase 9 audit improvements.

### DEFER-009 — `signOutEverywhereAction` / `forceReauth` rate-limiting
Source: F-044 (C-9)
Reason: low risk; session-gated. Out of scope for this phase.
Recommended next phase: Phase 9.

### DEFER-010 — `restoreLeadsById` version bump
Source: F-045 (E-D-3)
Reason: admin-only path; rare; not a behavioural bug.
Recommended next phase: tag onto the `withErrorBoundary` adoption sweep if convenient.

### DEFER-011 — Versioned-table delete OCC
Source: F-047 (C-17)
Reason: deletes are intent-explicit; OCC on delete is uncommon. Documented choice.

### DEFER-012 — `audit_log.targetType` standardisation
Source: F-041 (C-20)
Reason: cosmetic / future-tooling improvement; no current consumer relies on a normalised `targetType` filter.
Recommended next phase: Phase 9 audit-UI work.

### DEFER-013 — `users.password_hash` rename
Source: F-049 (B-9)
Reason: rename-only, no security or correctness benefit.
Recommended next phase: Phase 9 cleanup.

### DEFER-014 — Add CI guard requiring policy or service-role marker per new public table
Source: F-051 (D-5, B positive verification)
Reason: structural reminder, not a current bug. Worth doing but not on the Phase 8 critical path.
Recommended next phase: Phase 9 CI hardening.

### DEFER-015 — `convertLeadAction` `isRedirectError` standardisation
Source: F-040 (C-13)
Reason: subsumed by F-002 (withErrorBoundary). If FIX-002 doesn't centralize this, address as a one-liner in Phase 9.

### DEFER-016 — Import row-cap silent-truncation warning
Source: F-035 (E-I-12)
Reason: cap correctly enforced; UX-only nit.

### DEFER-017 — Double audit row on import commit
Source: F-036 (E-I-4)
Reason: clutter only, no integrity loss. Pick one and drop the other in Phase 9.

### DEFER-018 — Import template path mismatch claim doc
Source: F-037 (A-8)
Reason: claim-doc edit only.
Recommended next phase: include in Phase 9 docs cleanup.

### DEFER-019 — `resolveOwnerEmails` is_active/is_breakglass filter
Source: F-029 (E-I-11)
Reason: Medium-impact correctness fix that wasn't in the original triage rules but is a one-line WHERE clause. RECOMMEND PROMOTING TO FIX (single-line addition to `src/lib/import/resolve-users.ts:30-39`). If schedule allows, fold into Wave 5.

### DEFER-020 — `/api/auth/session` HEAD cache header
Source: F-052 (D-6)
Reason: Vercel/Next.js quirk; minimal risk.

---

## Top 5 fixes by impact

1. **FIX-002 — Adopt `withErrorBoundary` everywhere.** Single biggest UX/observability lever. Translates 23514 CHECK violations to ValidationError, gives every action a `requestId` for log correlation, normalizes return shapes. Unlocks F-001 and many smaller fixes.
2. **FIX-001 — Validation primitives on schemas.** Closes the input-validation gap upstream of FIX-002; first-line defense for `javascript:` URLs and CSV-injection name fields.
3. **FIX-007 + FIX-003 + FIX-004 — OCC in pipelines and import.** Three places where a versioned table can race silently. Combined, these eliminate every confirmed concurrency hole.
4. **FIX-005 + FIX-006 — CSP nonce wiring.** Restores the strict-CSP claim and unblocks auto-print on the print page.
5. **FIX-009 + FIX-008 + FIX-020 — Import path hardening.** Magic-byte gate, ownership filter on cancel, and sanitized error surfacing — closes the import-side security gaps in one bundled PR.

---

## Final summary

- **Total findings (deduped):** 38
- **Total fixes scheduled:** 23 (covering 28 of 38 findings; the rest deferred per triage rules)
- **By severity:** 1 Critical, 10 High, 18 Medium, 6 Low, 3 Info
- **Parallelism:** 8 waves; Waves 1–2 fully parallel (10+ fixes can run concurrently); Wave 3 (`withErrorBoundary` adoption) is the single L-effort serialisation point; Waves 4–8 are mostly parallel within wave.
- **Estimated calendar time** with one engineer: ~6–8 working days. With two engineers in parallel after Wave 3: ~4–5 days.
