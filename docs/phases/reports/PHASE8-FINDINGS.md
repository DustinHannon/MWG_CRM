# Phase 8 — Consolidated Findings

Total findings (deduped): 38
By severity: Critical=1, High=10, Medium=18, Low=6, Info=3
Source coverage: A=9 findings, B=12 findings, C=21 findings, D=6 findings, E=12 findings (raw); deduped to 38 unified entries.

Auditors covered: A (feature wiring, live walkthrough), B (DB integrity), C (server actions + routes), D (security probes), E (import + delete).

---

## Critical

### F-001 — `website` field accepts `javascript:`/`ftp:`; DB CHECK rejection surfaces as raw 500 with stack
Sources: A-1, D-2, E-V (implicit; D-V4 confirms DB CHECK works as defense in depth)
Area: Server actions / Validation
Evidence:
- `src/lib/leads.ts:83` uses `z.string().url().or(z.literal(""))` — accepts `javascript:`, `ftp://`, `data:`.
- `src/lib/validation/primitives.ts:52-59` defines `urlField` enforcing `^https?://` — exists but unused on lead schema.
- Vercel runtime logs digest 367469013 / 962170328 at 2026-05-07T20:35:16Z (deployment dpl_8YP12dPypr7YXwq3n7ZYHMhU3gUN) show `pg` error 23514 (`leads_website_protocol`) bubbling as unhandled 500 with stack trace.
- DB CHECKs `leads_website_protocol`, `leads_linkedin_url_protocol`, `crm_accounts_website_proto` correctly reject — defense in depth held; only the user-facing surface is broken.
Root cause: lead schema does not bind `urlField` to `website`/`linkedinUrl`; no error-boundary wrapper translates PG CHECK violations to `ValidationError`.
Recommended fix: switch lead schema (and accounts/contacts/opportunities equivalents) to `urlField`. Wrap server action in `withErrorBoundary` and translate PG SQLSTATE 23514 to a `ValidationError` carrying the constraint name.

---

## High

### F-002 — `withErrorBoundary` helper has 0% adoption across 38 server actions
Sources: C-1 (also surfaces in A-1, D-2, C-7, C-12, C-19 as the proximate cause of raw 500s and inconsistent error shapes)
Area: Server actions / Error handling
Evidence:
- `src/lib/server-action.ts:30` defines `withErrorBoundary`.
- Grep confirms 0 server actions or routes invoke it.
- Compliance table: 0/38 actions wrapped. 6+ distinct return shapes exist; some actions `throw new Error(...)` and leak Zod field names like `expectedVersion` to user UI. No `requestId` connects client error to server log.
Recommended fix: wrap every action in `withErrorBoundary({ action, userId, entityType, entityId }, async () => {…})` returning `ActionResult<T>`. Translate KnownError subclasses to public messages + stable codes. (M-effort refactor.)

### F-003 — Persistent CSP inline-script violation on every authenticated page (next-themes)
Sources: A-2, D-3
Area: Security / CSP
Evidence:
- Every authenticated page logs `Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'nonce-{rand}' 'strict-dynamic' 'unsafe-eval'`. Hash on every page: `sha256-zjP2BXYgSCCnXNMXI2IL1yRydoQdsGR/uCCr6kyKsD0=`.
- `src/components/theme/theme-provider.tsx` wraps `next-themes`' ThemeProvider, which injects an inline `<script>` for FOUC prevention; the per-request `x-nonce` header is not propagated to its `nonce` prop.
- Phase 3J acceptance gate ("zero CSP violations on every page") is failed.
Recommended fix: read `x-nonce` via `headers()` in the root layout and pass it to `<ThemeProvider nonce={nonce}>`.

### F-004 — Lead Print page auto-print blocked by CSP (separate inline script, missing nonce)
Sources: A-3, C-21, D-3 (additional hash `sha256-y3gpCDDmNK23YESmrGmfLT1RsG4QtPo7qAOLXg3WGyw=` on `/leads/print/[id]` only)
Area: UI / Print
Evidence:
- `src/app/leads/print/[id]/page.tsx:205-211` injects `dangerouslySetInnerHTML` with a static `setTimeout(window.print, 250)` and no nonce attribute.
- Console snapshot `console-2026-05-07T20-43-28-637Z.log` shows two inline-script CSP errors. `window.print()` never fires.
Recommended fix: read `x-nonce` from `headers()` and apply `nonce={nonce}` to the `<script>` tag, OR convert to a small client component using `useEffect`.

### F-005 — `updateOpportunityStageAction` (kanban DnD) lacks OCC version check
Sources: C-3
Area: Server actions / Concurrency
Evidence:
- `src/app/(app)/opportunities/pipeline/actions.ts:40-48` runs `db.update(opportunities).set({...}).where(eq(opportunities.id, id))` with no version compare-and-set despite `opportunities.version` existing.
Recommended fix: thread `expectedVersion` from kanban card; use `concurrentUpdate({ table: opportunities, id, expectedVersion, patch })` or add `eq(opportunities.version, expectedVersion)` + `expectAffected`.

### F-006 — `updateLeadStatusAction` (lead kanban DnD) lacks OCC version check
Sources: C-4
Area: Server actions / Concurrency
Evidence:
- `src/app/(app)/leads/pipeline/actions.ts:40-44` runs `db.update(leads).set({status, updatedById}).where(eq(leads.id, leadId))` despite the rest of lead-update pipeline using OCC via `updateLead`.
Recommended fix: refactor to call `updateLead(user, leadId, expectedVersion, { status })` and thread `version` through the kanban card form.

### F-007 — Re-import UPDATE silently no-ops on stale `version`; reports false success
Sources: E-I-3 (also relates to F-005/F-006 OCC family)
Area: Import / Concurrency
Evidence:
- `src/lib/import/commit.ts:160-228` runs `db.update(leads).set(...).where(and(eq(id), eq(version, existing.version))).returning(...)`. Drizzle's `returning()` empty array on WHERE mismatch does not throw.
- Surrounding `try/catch` for `ConflictError | NotFoundError` is therefore unreachable.
- Row pushed to `result.updatedLeadIds` even when 0 rows changed.
Recommended fix: replace bare update with `concurrentUpdate(...)` or check `inserted.length === 0` and push to `result.failedRows` with `Conflict` reason.

### F-008 — `cancelImportAction` lets any signed-in user cancel any other user's import job
Sources: C-16
Area: Server actions / Authorization
Evidence:
- `src/app/(app)/leads/import/actions.ts:212-223`: `getJob(jobId, user.id)` enforces ownership for the in-memory cache, but the subsequent `db.update(importJobs).set({status: "cancelled"}).where(sql`id = ${jobId}::uuid`)` has NO ownership clause.
- Any guessed UUID flips another user's job to `cancelled`.
Recommended fix: add `eq(importJobs.userId, user.id)` (admin override OK) to the WHERE.

### F-009 — Magic-byte validation never runs on import path
Sources: E-I-2, D-V13 (D notes the validator exists but isn't exercised on import)
Area: Import / File upload
Evidence:
- `src/app/(app)/leads/import/actions.ts:42-52` only checks `file.size > 10MB` and `file.name.endsWith(".xlsx")`.
- `validateAttachment` in `src/lib/validation/file-upload.ts` (which calls `fileTypeFromBuffer`) is never invoked from import path.
- Phase 4A.3 claim ("magic-byte verification; reject executables") is not honored on the import surface; rejection comes from exceljs's internal error, surfaced as `error.message`.
Recommended fix: invoke `validateAttachment` (or an import-specific variant restricting to spreadsheetml MIME) before `parseWorkbookBuffer`. Use `MAX_IMPORT_BYTES`.

### F-010 — Import accepts CSV-injection payloads in name fields (no `nameField` primitive)
Sources: E-I-1, D-1 (lead form schema also bypasses `nameField`)
Area: Import / Validation
Evidence:
- `src/lib/import/row-schema.ts:13-23` uses `z.string().trim().min(1).max(100)` — no charset regex.
- `src/lib/leads.ts:66` uses the same loose pattern for lead create/edit `firstName`/`lastName`.
- `src/lib/validation/primitives.ts:14-22` defines `nameField` enforcing `^[\p{L}\p{M}'.\-\s]+$` — exported but unused on either path.
- Fixture `test-data/phase8e-formula-injection.xlsx` would persist `+CMD|'/c calc.exe'!A1` and `@SUM(A1)` unaltered. On re-export, Excel would execute the formula.
Recommended fix: bind `nameField` to firstName/lastName/salutation/companyName/jobTitle/industry on both import and form schemas. For columns where the regex rejects too much real-world data, escape leading `=+@-\t\r` at write time.

### F-011 — `activity_kind` enum drift: missing `sms` and `task_completed`
Sources: B-1, B-11
Area: Data / DB / Schema
Evidence:
- `pg_enum` `activity_kind = {email, call, meeting, note, task}`.
- Phase 5B claim states the counting set is `{note, call, email, meeting, sms, task_completed}` — two values cannot be inserted.
- `src/lib/activities.ts:114-118` only fires `bumpLastActivityAt` on `createNote` and `createCall`. Email/meeting (Phase 7) bypass the bump entirely.
- Smart-detect parser (`activity-parser.ts:324, 379`) emits only `note`/`call`/`email`. No `sms` helper exists.
Recommended fix: pick one path — (a) update Phase 5B claim to match the actual 5-value enum and ensure all 4 insert helpers gate `bumpLastActivityAt` correctly, OR (b) `ALTER TYPE` to add `sms`/`task_completed` plus wire the helpers.

### F-012 — `leads.tags text[]` legacy column still present alongside relational `lead_tags`
Sources: B-2
Area: Data / DB / Schema
Evidence:
- `information_schema.columns` confirms `leads.tags ARRAY` still present, nullable.
- Phase 3C and PHASE8-CLAIMS line 42 both assert it would be deprecated after backfill.
- Index `leads_tags_gin_idx` continues to exist on the column.
- Two sources of truth — drift risk if any code path still writes to it.
Recommended fix: grep + remove any remaining writers, then drop column + GIN index in a Phase 8 migration.

---

## Medium

### F-013 — `public.user_manager_links` view is `SECURITY DEFINER`
Sources: B-3
Area: Data / DB / Security
Evidence: Supabase advisor `security_definer_view` ERROR; `public.user_manager_links` defined with SECURITY DEFINER (Phase 5E partial). Practical impact zero today (BYPASSRLS roles, no policies), but flagged as ERROR-level lint.
Recommended fix: `ALTER VIEW public.user_manager_links SET (security_invoker = true);`

### F-014 — `leads_last_activity_idx` not partial despite Phase 5B claim
Sources: B-4
Area: Data / DB / Indexes
Evidence: actual: `CREATE INDEX … (last_activity_at DESC NULLS LAST)`. Claim says `WHERE is_deleted = false`. Empty-DB impact zero; future cost as soft-deleted volume grows.
Recommended fix: drop and recreate as partial index `WHERE is_deleted = false`.

### F-015 — `pg_trgm` and `unaccent` extensions installed in `public` schema
Sources: B-5
Area: Data / DB / Hygiene
Evidence: Supabase advisor `extension_in_public` (WARN ×2). No correctness issue.
Recommended fix: `ALTER EXTENSION … SET SCHEMA extensions;` — touches every `pg_trgm`-using index DDL; schedule as maintenance window. Defer if disruptive.

### F-016 — 8 unindexed FK columns flagged by performance advisor
Sources: B-6
Area: Data / DB / Indexes
Evidence: Supabase performance advisor `unindexed_foreign_keys`: `accounts.userId`, `contacts.deleted_by_id`, `crm_accounts.deleted_by_id`, `lead_scoring_rules.created_by_id`, `lead_scoring_settings.updated_by_id`, `leads.deleted_by_id`, `opportunities.deleted_by_id`, `tasks.deleted_by_id`. User-deletion cascades will sequential-scan once user count grows.
Recommended fix: add btree partial indexes `WHERE <fk> IS NOT NULL` per column.

### F-017 — Lead form lacks Subject input despite shipped `leads.subject` column + FTS index
Sources: A-5
Area: UI / Forms
Evidence: `/leads/new` and `/leads/[id]/edit` have no subject input. Schema, FTS index, and detail-page render (`src/app/(app)/leads/[id]/page.tsx:76-77`) all correctly wired. Phase 6A claim says column + FTS shipped; UI not.
Recommended fix: add `<textarea name="subject" maxLength={1000}>` to `lead-form.tsx` (Notes section, above Description).

### F-018 — TagInput combobox built but lead form still uses comma-separated text input
Sources: A-6
Area: UI / Forms
Evidence: `src/components/tags/tag-input.tsx` exists; zero usages outside its own file. `src/app/(app)/leads/lead-form.tsx:127` uses plain `<Input name="tags" label="Tags (comma-separated)" />`. Phase 3C claim of combobox/multiselect not honored on form. (Bulk-tag toolbar is on PHASE8-DEFERRED list; per-lead form is not.)
Recommended fix: replace plain Input with `<TagInput>`.

### F-019 — `db.update(leads).set({lastActivityAt: null})` with no WHERE clause; admin nuke
Sources: C-6
Area: Server actions / Concurrency
Evidence: `src/app/admin/data/actions.ts:79`. Admin-only and confirmed-text gated, but does not bump `version`/`updatedAt`. Concurrent edits in flight when admin runs this will silently mix.
Recommended fix: add `where(isNotNull(leads.lastActivityAt))` and `set({ updatedAt: sql\`now()\` })`. Document why version bump is intentionally skipped.

### F-020 — `updateAdminFlag` / `updateActiveFlag` / `forceReauth` raw `throw new Error(...)`
Sources: C-7
Area: Server actions / Error handling
Evidence: `src/app/admin/users/[id]/actions.ts:58-165`. Three actions throw raw `Error` with internal messages ("Refusing to remove your own admin flag.", "Cannot deactivate the breakglass account.") that bubble verbatim through Next.js's server-action error path with no `requestId` and no stable code.
Recommended fix: convert to `ForbiddenError`/`ConflictError` from `lib/errors.ts`; wrap with `withErrorBoundary` (covered by F-002).

### F-021 — `bulkTagLeadsAction` writes audit rows in N-row sequential loop
Sources: C-11
Area: Server actions / Performance
Evidence: `src/components/tags/actions.ts:127-138`. Up to 1000 lead ids → 1000 sequential audit INSERTs → easy to time out the action.
Recommended fix: replace loop with single bulk `db.insert(auditLog).values([...])`. Optional: aggregate to one audit row with `after.leadIds=[...]`.

### F-022 — Inconsistent server-action return shapes (6+ variants)
Sources: C-12, C-19
Area: Server actions / API contract
Evidence: `{ok,error?}`, `{ok,error?,fieldErrors?}`, `{ok,error?,code?}`, `{ok,version}`, `{ok,processed}`, `redirect()`, raw `throw`, mixed. `ActionResult<T>` from `lib/server-action.ts` is unused. Some actions surface `parsed.error.errors[0]?.message` directly, leaking Zod internal field names.
Recommended fix: subsumed by F-002 — adopt `withErrorBoundary` + `ActionResult<T>` everywhere.

### F-023 — `previewImportAction`/`commitImportAction` write raw `String(err)` to `import_jobs.errors`
Sources: C-14
Area: Server actions / Logging
Evidence: `src/app/(app)/leads/import/actions.ts:112,178`: `errors: [{ row: 0, field: "_fatal", message: String(err) }] as unknown as object`. `String(err)` can leak DB connection strings, stack traces. The field is read by the import preview UI and surfaces to the user.
Recommended fix: log full err via `logger.error`; store generic `"Preview failed"` / `"Commit failed"` in `errors`.

### F-024 — Hard-delete and 30-day purge cron leak Vercel Blob attachments
Sources: E-D-1
Area: Delete / Storage
Evidence:
- `src/app/(app)/leads/actions.ts:hardDeleteLeadAction` and `src/lib/leads.ts:402-405` (`deleteLeadsById`) just `db.delete(leads)`; cascade kills activity/attachment rows but blob objects persist.
- `src/app/api/cron/purge-archived/route.ts:54-66` has no blob cleanup either.
- Admin user-delete (`src/app/admin/users/[id]/delete-user-actions.ts:182-205`) DOES correctly call `cleanupBlobsForUser` outside the transaction — pattern proven, just not applied here.
- Comment says "Vercel Blob cleanup runs separately" but no scheduled task does it. `scripts/orphan-scan.ts` is detection only.
Recommended fix: gather blob pathnames before DB delete in both `hardDeleteLeadAction` and the purge cron; `void cleanupBlobsForLead(...).catch(log)` outside the transaction.

### F-025 — Tag autocreate on import lacks length/charset validation
Sources: E-I-6
Area: Import / Validation
Evidence: `src/lib/import/commit.ts:71-83, 414-460`; `src/db/schema/tags.ts` has no CHECK on `tags.name`. The `tagName` primitive (`primitives.ts:84-88`) caps at 50 chars + restricts charset but is unused. Admin-UI rules apply elsewhere; import bypasses them.
Recommended fix: apply `tagName.safeParse(trimmed)` per tag in `ensureTags`; surface as row warning, skip the tag, continue.

### F-026 — Import file size cap inconsistent with documented 25 MB
Sources: E-I-7
Area: Import / Validation
Evidence: `src/app/(app)/leads/import/actions.ts:49` uses inline `10 * 1024 * 1024`. Constant `MAX_IMPORT_BYTES = 25 MB` exists in `primitives.ts:130`. Phase 4A.3 claim says 25 MB.
Recommended fix: replace literal with `MAX_IMPORT_BYTES`.

### F-027 — Import `lastActivityAt` patch path uses non-versioned UPDATE
Sources: E-I-8
Area: Import / Concurrency
Evidence: `src/lib/import/commit.ts:402-410`: `db.update(leads).set({ lastActivityAt }).where(eq(leads.id, leadId))` — no version bump, no compare-and-set. Bypasses OCC even after F-007 is fixed.
Recommended fix: fold into the main UPDATE statement, OR add `version: sql\`${leads.version} + 1\`` plus version check.

### F-028 — Activity dedup-key only hashes first 200 body chars
Sources: E-I-9
Area: Import / Correctness
Evidence: `src/lib/import/dedup-key.ts:13` (`BODY_HASH_LENGTH = 200`). Two long-body activities sharing first 200 chars will silently dedup on re-import.
Recommended fix: hash full body (sha256 length-agnostic).

### F-029 — `resolveOwnerEmails` doesn't filter inactive/breakglass users
Sources: E-I-11
Area: Import / Validation
Evidence: `src/lib/import/resolve-users.ts:18-40` matches by email regardless of `is_active=false` or `is_breakglass=true`. Routes ownership to soft-disabled users who can't act on it.
Recommended fix: add `AND is_active = true AND is_breakglass = false` to WHERE.

### F-030 — `resolveByNames` does full-table scan over users
Sources: E-I-10
Area: Import / Performance
Evidence: `src/lib/import/resolve-users.ts:42-80` fetches every user with no WHERE; iterates client-side. OK at current scale (~50 users) but unbounded as org grows.
Recommended fix: add `WHERE lower(display_name) IN (...) OR lower(first_name||' '||last_name) IN (...)`.

---

## Low

### F-031 — Lead detail "Delete" button labeled wrong (action soft-deletes)
Sources: A-4
Area: UI / Labels
Evidence: `src/app/(app)/leads/[id]/page.tsx:161` reads "Delete"; the action it calls is `archiveLeadsById` (soft-delete). Phase 4G claim says button should read "Archive". Audit log already correctly writes `lead.archive`.
Recommended fix: rename label to "Archive".

### F-032 — Activity feed empty state shows stale "Phase 7" message
Sources: A-7
Area: UI / Copy
Evidence: `src/app/(app)/leads/[id]/activities/activity-feed.tsx:37` reads "Email and meeting activities arrive in Phase 7." Phase 7 has shipped.
Recommended fix: drop the "arrive in Phase 7" sentence.

### F-033 — Cron endpoints redirect external callers to sign-in instead of returning 401
Sources: D-4
Area: Routes / Auth
Evidence: `curl -i /api/cron/rescore-leads` returns 307 to `/auth/signin?callbackUrl=...`. `src/proxy.ts:~74` redirects on missing session before route's bearer check (`route.ts:14-19`) ever runs. Vercel cron's internal calls bypass middleware so production cron still works, but external probes get the wrong response shape.
Recommended fix: add `/api/cron/` to `PUBLIC_PATH_PREFIXES` in `src/proxy.ts` so route handler returns its own 401.

### F-034 — `leads_external_id_idx` redundant with `leads_external_id_unique`
Sources: B-8
Area: Data / DB / Indexes
Evidence: `pg_indexes` shows both. Idle-index advisor flags `leads_external_id_idx` as unused. Every insert/update writes to two indexes.
Recommended fix: `DROP INDEX leads_external_id_idx;`

### F-035 — Import row-cap truncation is silent (no warning)
Sources: E-I-12
Area: Import / UX
Evidence: `parse-workbook.ts:71` loops `Math.min(sheet.rowCount, MAX_ROWS+1)` — extras silently dropped. Cap correctly enforced (10k rows) but user not informed.
Recommended fix: when `sheet.rowCount > MAX_ROWS+1`, push warning into preview ("File contained N rows; only the first 10,000 were processed").

### F-036 — Double audit row on import commit
Sources: E-I-4
Area: Import / Audit
Evidence: `src/lib/import/commit.ts:135-151` writes `import.commit`; `src/app/(app)/leads/import/actions.ts:148-167` writes `leads.import`. Two rows describing same event. Phase 6F claim says one.
Recommended fix: drop one; keep the wider-scope `leads.import` for searchability.

### F-037 — Import path mismatch (claim says `/leads/import/template`, actual `/api/leads/import-template`)
Sources: A-8
Area: Routes / Docs
Evidence: link on `/leads/import` correctly points to `/api/leads/import-template`. Phase 6G claim string is stale.
Recommended fix: update Phase 6G claim doc OR add a redirect at `/leads/import/template`.

### F-038 — `searchTagsAction` / `getOrCreateTagAction` lack length/charset gates and per-user filtering
Sources: C-18
Area: Server actions / Hardening
Evidence: `src/components/tags/actions.ts:39-58`. Tags are org-shared by design (no per-user partition in schema), so enumeration is intentional, but `getOrCreateTagAction` has no length cap or regex — any signed-in user can create thousands of garbage tag rows.
Recommended fix: apply `tagName` primitive in `getOrCreateTag`. (Pairs with F-025.)

### F-039 — `subscribeToViewAction` doesn't catch FK violations gracefully
Sources: C-10
Area: Server actions / UX
Evidence: `src/app/(app)/settings/subscriptions-actions.ts:38-58` upserts subscription; if savedView is deleted between read and write, Postgres FK fires; not user-friendly.
Recommended fix: catch the FK violation, translate to `NotFoundError`. (Subsumed largely by F-002.)

### F-040 — `convertLeadAction` brittle redirect-error sentinel
Sources: C-13
Area: Server actions / Hygiene
Evidence: `src/app/(app)/leads/[id]/convert/actions.ts:46`: `if (err && typeof err === "object" && "digest" in err) throw err;` — fragile duck-test; `signInBreakglassAction` does the safer `digest.startsWith("NEXT_REDIRECT")` check.
Recommended fix: use `isRedirectError` from `next/dist/client/components/redirect`, or align both spots on `digest.startsWith("NEXT_REDIRECT")`.

### F-041 — `audit_log.targetType` drift — singular vs plural
Sources: C-20
Area: Server actions / Audit
Evidence: `updateLeadStatusAction` writes `"leads"`; `updateOpportunityStageAction` writes `"opportunities"`; most other lead actions write `"lead"`; `signOutEverywhereAction`/`disconnectGraphAction`/`forceReauth` write `"users"`/`"accounts"`. Audit-log filter UIs that filter by `targetType` cannot match cleanly.
Recommended fix: standardise on table-name singular ("`lead`", "`activity`", "`task`", "`opportunity`", "`user`", "`account`", "`saved_view`").

### F-042 — Cron endpoints rely on shared bearer secret rather than `x-vercel-cron-signature`
Sources: C-15
Area: Routes / Defense in depth
Evidence: 4 cron routes validate `Authorization: Bearer ${env.CRON_SECRET}`. Vercel platform supports `x-vercel-cron-signature`; bearer is functionally equivalent today but a leaked CRON_SECRET = full external invocation.
Recommended fix: optional defense-in-depth — add `x-vercel-cron-signature` check alongside bearer.

### F-043 — `disconnectGraphAction` audit doesn't snapshot before-state
Sources: C-8
Area: Server actions / Audit
Evidence: `src/app/(app)/settings/actions.ts:162-191` overwrites `accounts.access_token` etc. with NULL; no audit captures which provider tokens existed pre-disconnect. Re-running is idempotent so impact is low.
Recommended fix: capture provider/providerAccountId snapshot (NOT token values) in audit.

### F-044 — `signOutEverywhereAction` and `forceReauth` lack rate-limiting
Sources: C-9
Area: Server actions / Hardening
Evidence: each is a single click that mutates `session_version`; no token bucket. Breakglass authorize() has rate limiting (`src/auth.ts:56`); nothing else does.
Recommended fix: low priority. Add an in-process token bucket on user-id.

### F-045 — `restoreLeadsById` doesn't bump `version`
Sources: E-D-3
Area: Server actions / Concurrency
Evidence: `src/lib/leads.ts:436-452` clears soft-delete columns without incrementing version. Inconsistent with Phase 4A.7 "every UPDATE bumps version" claim.
Recommended fix: add `version: sql\`${leads.version} + 1\``. (Admin-only path; rare.)

### F-046 — `updateLead` may match soft-deleted rows on stale concurrent edit
Sources: E-D-9
Area: Server actions / Concurrency
Evidence: if user A archives a lead while user B has an open edit form with same version, B's update may silently overwrite the archived row's data unless `updateLead` WHERE includes `is_deleted = false`. Audit E couldn't confirm without reading the helper body.
Recommended fix: ensure `updateLead`'s WHERE clause explicitly includes `is_deleted = false` so concurrent archive surfaces as `NotFoundError`.

### F-047 — `deleteScoringRuleAction` / `deleteTaskAction` have no expected-version on delete
Sources: C-17
Area: Server actions / Concurrency
Evidence: `src/app/admin/scoring/actions.ts:179` and `src/lib/tasks.ts:202` delete versioned-table rows by id only. Delete-after-edit race wipes a rule the admin no longer wanted to delete.
Recommended fix: low priority. Document the choice or add expected-version in the delete WHERE.

### F-048 — Two parallel access-control modules; `lib/access.ts` is dead code
Sources: C-2
Area: Server actions / Architecture
Evidence: `src/lib/access.ts` and `src/lib/auth-helpers.ts` both define `requireLeadAccess` etc. with subtly different rules. Every call site uses `auth-helpers.ts`. The `denyAndLog` audit-on-deny path in `lib/access.ts` is the better implementation but unused — denied-access events are not audit-logged in production.
Recommended fix: pick one. Either delete `lib/access.ts` (with note that audit-on-deny is a TODO), OR migrate every caller to it (broader but invasive).

---

## Info

### F-049 — `users.password_hash` not prefixed `breakglass_*`
Sources: B-9
Area: Data / DB / Naming
Evidence: column functionally fine; only breakglass user has a hash. Name suggests every user might.
Recommended fix: rename in a future migration. (Not a security bug.)

### F-050 — `users` view-mode subtitle falls back to `email` when `jobTitle` is null
Sources: A-9
Area: UI / Display
Evidence: breakglass has no Entra `jobTitle`; subtitle shows `breakglass@local.mwg-crm`. Phase 3B claim accepts when title present — code reads `subtitle = jobTitle ?? email` (`src/components/user-panel/user-panel.tsx:42`). Acceptable for breakglass.
Recommended fix: none required; verify behavior with a real Entra user with populated jobTitle in Phase 7 acceptance.

### F-051 — All 23 public tables RLS-enabled with zero policies (documented architecture)
Sources: D-5, B (positive verifications)
Area: Data / DB / Architecture
Evidence: 23/23 tables RLS-enabled, 0 policies. Service-role key bypass is the documented pattern. Vulnerability iff a future client-side anon/authenticated key is added without writing policies.
Recommended fix: add a CI check that fails build if any new `public.*` table is added without either explicit `policy CREATE` or a `-- service-role only` comment marker.

### F-052 — `/api/auth/session` HEAD returns `Cache-Control: public`; GET correctly says `private`
Sources: D-6
Area: Routes / Caching
Evidence: HEAD: `public, max-age=0, must-revalidate`; GET: `private, no-cache, no-store`. `must-revalidate` limits practical exposure; method-keyed caches don't usually pollute.
Recommended fix: low priority; verify with Vercel.

### F-053 — Import-job cache is process-local; "Vercel Runtime Cache fallback" claim incorrect
Sources: E-I-5
Area: Import / Architecture
Evidence: `src/lib/import/job-cache.ts` is a module-scope `Map`. No Vercel Runtime Cache integration. Phase 6F claim asserts both. Currently single-region, so impact minimal — preview→commit on different lambda instance returns "Preview expired".
Recommended fix: either implement `@vercel/functions runtimeCache` fallback, or update claim text to "in-process only". Defer to Phase 9 unless multi-region planned.

### F-054 — `dangerouslySetInnerHTML` use in print page (static literal; safe but flagged)
Sources: C-21, A-3 (related — same line is the CSP nonce-gap source)
Area: UI / Hygiene
Evidence: `src/app/leads/print/[id]/page.tsx:208` — hard-coded `setTimeout(window.print, 250)` literal, no interpolation. Safe under XSS rules but flagged by Phase 4A "no `dangerouslySetInnerHTML`" rule.
Recommended fix: covered by F-004; once converted to client-component `useEffect` or nonce-tagged, the dangerouslySet flag goes away.

---

## Not findings (verified intentional or deferred)

- **B-7** (`activities_one_parent` CHECK semantics): per Audit B, "not a finding; documented for clarity."
- **B-10** (`leads.imported_by_name` doesn't exist; only on `activities`): claim was always activity-scoped; Phase 8 dirty-data §11 retargets to `activities.imported_by_name`. Not a bug.
- **B-12** (`audit_log.actor_email_snapshot` preservation): no current drift; verified by definition.
- **D-V*** entries: all PASS — included for completeness in audit reports; no consolidation needed.
- **Bulk-tag toolbar UI / DnD column reorder UI / OCC banner polish**: explicitly listed in `PHASE8-DEFERRED.md`.
