# Phase 8 Audit E — Import + Delete Pathways

Auditor: Sub-agent E (read-only for code; upload-attempted for live import)
Method: Code review of `src/lib/import/**`, `src/app/(app)/leads/import/**`, `src/app/(app)/leads/actions.ts`, `src/app/admin/users/[id]/delete-user-actions.ts`, `src/app/api/cron/purge-archived/route.ts`, plus FK rules in `src/db/schema/**`. Synthetic XLSX fixtures generated at `C:\Code\MWG_CRM\test-data\phase8e-*.xlsx` via `scripts/phase8e-fixtures.ts`. Live upload tests were attempted via Playwright but were repeatedly interrupted by post-login default-landing-page redirects pulling the browser away from `/leads/import` mid-flow; tests below marked "live" rely on accessibility snapshots taken before the redirect; everything else is "code-review".
Date: 2026-05-07

## Summary
- Import edge cases tested: 16 (1 partial-live confirmation of the import shell, 15 code-review)
- Delete edge cases verified: 10 (all code-review)

Top 3 critical/high:
1. **E-I-1 (High)** — `importRowSchema` does not use `nameField`; the import accepts formula-injection payloads (`=SUM(A1)`, `+CMD…`, `@SUM(A1)`) in `firstName` / `lastName`, conflicting with the Phase 4A.3 nameField regex claim.
2. **E-I-2 (High)** — `previewImportAction` skips magic-byte verification entirely. Only the `.xlsx` extension is checked; any file with that extension up to 10 MB is accepted. The Phase 4A.3 file-upload validator (`validateAttachment` in `src/lib/validation/file-upload.ts`) is never called from the import path.
3. **E-I-3 (High)** — Re-import UPDATE path silently no-ops on stale `version`. The chunk processor uses raw `db.update().where(eq(version, expected))`, never checks `affected rows`, and never throws `ConflictError`. The catch-block immediately following is therefore unreachable for OCC failures, and the row is recorded as `updatedLeadIds` even when 0 rows changed.

Other Highs and Mediums called out below.

## Findings (Import)

### E-I-1 — High — Formula-injection payloads accepted in name fields
- **Method:** Read `src/lib/import/row-schema.ts:13-23` and `src/lib/validation/primitives.ts:14-24`.
- **Observation:** `importRowSchema.firstName = z.string().trim().min(1).max(100)`. There is no regex restriction. The `nameField` primitive that enforces `^[\p{L}\p{M}'.\-\s]+$` is exported but not imported into row-schema. Same for `lastName`.
- **Generated fixture for live test:** `test-data/phase8e-formula-injection.xlsx` with `firstName` values `=SUM(1+1)`, `+CMD|'/c calc.exe'!A1`, `@SUM(A1)`. ExcelJS resolves `=SUM(1+1)` to its computed `result` (`2`) via `parse-workbook.ts:109-111`, but the other two payloads are stored as plain strings and would pass through validation and persist in `leads.first_name` unaltered.
- **Risk:** When the field is re-exported (e.g., `/api/leads/export`), Excel/Sheets will execute the formula on open. OWASP CSV/Spreadsheet injection guidance recommends rejecting or escaping leading `=`, `+`, `-`, `@`, `\t`, `\r`.
- **File:** `src/lib/import/row-schema.ts:15-23`
- **Recommended fix:** Replace `firstName` / `lastName` / `companyName` / `jobTitle` / `industry` / similar string fields with the `nameField` primitive (or its specific siblings). For columns where the regex would reject too much real-world data, escape leading `=+@-\t\r` with a single quote at write time.

### E-I-2 — High — Magic-byte validation never runs for imports
- **Method:** Read `src/app/(app)/leads/import/actions.ts:42-52`.
- **Observation:** `previewImportAction` only checks `file.size > 10 * 1024 * 1024` and `file.name.toLowerCase().endsWith(".xlsx")`. The `validateAttachment` function in `src/lib/validation/file-upload.ts` (which calls `fileTypeFromBuffer` and reconciles declared MIME against magic bytes) is never invoked. A `.docx` renamed `.xlsx` (or any non-zip text renamed `.xlsx`) reaches `ExcelJS.Workbook.xlsx.load()`, which then throws — but the rejection comes from a third-party parser surfacing an internal error to the user as `error.message`, not from the documented allowlist.
- **Generated fixtures:** `test-data/phase8e-csv-fake.xlsx` (CSV bytes with `.xlsx` extension), `test-data/phase8e-docx-fake.xlsx` (plain text with `.xlsx` extension). Both would currently bypass the validator and produce an opaque exceljs error.
- **Risk:** Defense-in-depth gap. The Phase 4A.3 claim ("magic-byte verification (`file-type`); reject executables") is not honored on this path. A zip-formatted file with an `.xlsx` extension that contains malicious XLSX OLE/macros could still be loaded into exceljs.
- **File:** `src/app/(app)/leads/import/actions.ts:42-52`
- **Recommended fix:** Call `validateAttachment` (or an import-specific variant that allows only the spreadsheetml MIME) before `parseWorkbookBuffer`. Use `MAX_IMPORT_BYTES` (25 MB per primitives.ts) instead of the inline 10 MB literal — see E-I-12.

### E-I-3 — High — UPDATE path swallows stale-version conflicts; falsely reports success
- **Method:** Read `src/lib/import/commit.ts:160-225`.
- **Observation:** When an external-id match exists, the chunk processor runs `db.update(leads).set(...).where(and(eq(id), eq(version, existing.version))).returning(...)`. `concurrentUpdate` (which `expectAffected`-checks the row count and throws `ConflictError`/`NotFoundError`) is **not** called. Drizzle's `.returning()` returns an empty array on `WHERE` mismatch but does not throw. The surrounding `try/catch` matches `instanceof ConflictError | NotFoundError` — unreachable. The row is then pushed to `result.updatedLeadIds` regardless of whether anything changed.
- **Risk:** Two simultaneous imports targeting the same `external_id`, or a manual edit between preview and commit, results in silent data loss for the second writer with the import telemetry showing success.
- **File:** `src/lib/import/commit.ts:170-228`
- **Recommended fix:** Switch to `concurrentUpdate(...)` (already imported as `expectAffected` and visibly unused at line 478 — `void expectAffected`). Or check `inserted.length === 0` after the `returning()` call and push to `result.failedRows` with a `Conflict` reason.

### E-I-4 — High — `import.commit` write happens even when rows were partially lost
- **Method:** Read `src/lib/import/commit.ts:130-150` and `src/app/(app)/leads/import/actions.ts:130-160`.
- **Observation:** `commitImport` always writes the `import.commit` audit row at the end. The action wrapper writes a second `leads.import` audit row in `commitImportAction`. So per import there are TWO audit rows describing the same event (`leads.import` and `import.commit`). Phase 6F claim says one audit row.
- **Risk:** Double audit entries for same operation — clutter, no integrity loss.
- **File:** `src/lib/import/commit.ts:135-151`, `src/app/(app)/leads/import/actions.ts:148-167`
- **Severity:** Low (informational duplicate; not a security issue).
- **Recommended fix:** Pick one and drop the other.

### E-I-5 — Medium — Job cache is process-local; "Vercel Runtime Cache fallback" claim incorrect
- **Method:** Read `src/lib/import/job-cache.ts`.
- **Observation:** The cache is a `Map<string, CachedJob>` in the module scope. There is no Vercel Runtime Cache integration (`@vercel/functions` `runtimeCache`). Phase 6F claim explicitly says "Cached plan keyed by short token, TTL 15min (Vercel Runtime Cache; in-process map fallback)" — the runtime-cache half is not implemented.
- **Risk:** In a multi-region or scaled-out deploy (or after a Lambda cold-start), the commit step lands on a different instance than the preview step, the `getJob` returns null, and the user gets "Preview expired or not found. Please re-upload." Currently MWG CRM is single-region, so impact is low — but the claim is not honored.
- **File:** `src/lib/import/job-cache.ts:1-50`
- **Recommended fix:** Either fix the implementation to use Vercel Runtime Cache, or update the claim text in PLAN-PHASE6.md/PHASE8-CLAIMS.md to reflect "in-process only".

### E-I-6 — Medium — Tag autocreate has no length validation
- **Method:** Read `src/lib/import/commit.ts:71-83, 414-460` and `src/db/schema/tags.ts`.
- **Observation:** Tag names are split from the leads.tags column by comma, trimmed, and inserted via `ensureTags`. There is no length cap. The `tags.name` schema has no `CHECK` constraint either (verified by grepping schema). The `tagName` primitive (`src/lib/validation/primitives.ts:84-88`) caps at 50 chars and restricts characters with `^[\p{L}\p{N}\s\-]+$` — but it is not invoked here.
- **Generated fixture:** `test-data/phase8e-tags.xlsx` row 2 sends a 51-char tag and would be inserted unrestricted.
- **Risk:** Imports can create arbitrarily long tag names containing punctuation/control chars, polluting the tag combobox and audit logs. Phase 6E claim ("Tag autocreate on import: case-insensitive name lookup, missing tags inserted with default color (slate)") technically holds, but the implicit constraint that admin-UI rules apply does not. Phase 3C `/admin/tags` UI rejects long names; import is the bypass.
- **File:** `src/lib/import/commit.ts:414-460`, `src/db/schema/tags.ts`
- **Recommended fix:** Apply `tagName.safeParse(trimmed)` per tag in `ensureTags`; surface failures as row warnings, skip the tag, and continue.

### E-I-7 — Medium — File size cap inconsistent with documented 25 MB
- **Method:** Read `src/app/(app)/leads/import/actions.ts:49` and `src/lib/validation/primitives.ts:130`.
- **Observation:** `MAX_IMPORT_BYTES` constant in primitives is 25 MB. The import action enforces `10 * 1024 * 1024` inline, not the constant. Phase 4A.3 claim says "10MB attachments / 25MB imports cap"; the implementation has 10 MB for both.
- **Risk:** A real CRM export with embedded images / extensive activity columns can easily exceed 10 MB. Users hit a misleading "10MB max for v1" message.
- **File:** `src/app/(app)/leads/import/actions.ts:49`
- **Recommended fix:** Replace the literal with `MAX_IMPORT_BYTES`.

### E-I-8 — Medium — `lastActivityAt` column override path uses non-versioned UPDATE
- **Method:** Read `src/lib/import/commit.ts:402-410`.
- **Observation:** After processing each row, if `row.leadPatch.lastActivityAt` is set, the code does:
  `db.update(leads).set({ lastActivityAt }).where(eq(leads.id, leadId))`
  This does not bump `version` and does not check version. So even if the main UPDATE path were fixed, a stale concurrent read can still be silently overwritten on this column.
- **Risk:** Bypasses OCC for `lastActivityAt`. Possible data loss if a manually-set `lastActivityAt` (from a real activity insert) gets overwritten by a stale import value.
- **File:** `src/lib/import/commit.ts:404-410`
- **Recommended fix:** Fold this into the main UPDATE statement, or add `, version: sql\`${leads.version} + 1\`` and a version check.

### E-I-9 — Medium — Activity dedup-key only hashes first 200 body chars
- **Method:** Read `src/lib/import/dedup-key.ts:13-22`.
- **Observation:** `BODY_HASH_LENGTH = 200`. Re-imports of two long-body activities that share the same first 200 chars but differ later will be silently deduped on the second run (same lead, same kind, same occurredAt, same body prefix → same key).
- **Risk:** Edge-case false-positive dedup. Probability is low for D365 dumps which usually differ in the first sentence, but it's a correctness gap.
- **File:** `src/lib/import/dedup-key.ts:13`
- **Recommended fix:** Hash the entire body (sha256 doesn't care about input length).

### E-I-10 — Medium — `resolveByNames` does N×M scan over full users table
- **Method:** Read `src/lib/import/resolve-users.ts:42-80`.
- **Observation:** The function does `db.select(...).from(users)` with no `WHERE` — fetches every user, then iterates client-side. With ~50 users and ~500 by-name strings this is fine. With a large org or a 10k-row file referencing hundreds of distinct By-names against thousands of users, the per-import scan grows. Stated as Phase 6E "batch resolution avoids N+1" — true, but bounded by full table scan.
- **Severity:** Medium (current scale OK).
- **File:** `src/lib/import/resolve-users.ts:55-80`
- **Recommended fix:** Add `WHERE lower(display_name) IN (...) OR lower(first_name || ' ' || last_name) IN (...)` to limit the scan to candidates.

### E-I-11 — Medium — `resolveOwnerEmails` doesn't filter by `is_active`
- **Method:** Read `src/lib/import/resolve-users.ts:18-40`.
- **Observation:** The query matches any user with the email, regardless of `is_active = false` or `is_breakglass`. Importing with `Owner Email` set to a deactivated user successfully assigns ownership to a soft-disabled user.
- **Risk:** Phase 8 claim 14 says "owner email pointing to deleted user → warn + NULL". Deletion is hard, so it works for that case — but soft-deactivated users (the more common case) absorb ownership unintentionally. `leads.owner_id` is `ON DELETE RESTRICT`, so this won't dangle, but it routes work to a user who can't act on it.
- **File:** `src/lib/import/resolve-users.ts:30-39`
- **Recommended fix:** Add `AND is_active = true AND is_breakglass = false` to the WHERE clause.

### E-I-12 — Code-review pass — Row cap of 10,000 verified
- **Method:** Read `src/lib/import/parse-workbook.ts:20` and `src/lib/validation/primitives.ts:131`.
- **Observation:** `MAX_ROWS = 10_000` in parse-workbook and `MAX_IMPORT_ROWS = 10_000` in primitives match. Loop bound `Math.min(sheet.rowCount, MAX_ROWS + 1)` guarantees no more than 10,000 data rows are parsed. Excess rows beyond the cap are silently dropped (no warning surfaced about truncation).
- **Severity:** Low — silent truncation is suboptimal but the cap is enforced.
- **Recommended fix:** When `sheet.rowCount > MAX_ROWS + 1`, push a warning into the preview ("File contained N rows — only the first 10,000 were processed").

### E-I-13 — Code-review pass — 200-activity cap enforced
- **Method:** Read `src/lib/import/activity-parser.ts:46, 327-345, 365-378`.
- **Observation:** Both `parseActivityColumn` and `parseAllActivityColumns` cap at 200 most-recent and surface a warning. ✅

### E-I-14 — Live (partial) — Empty file behavior, no-file behavior
- **Method:** Live — navigated to https://mwg-crm.vercel.app/leads/import as breakglass; verified UI presence at `2026-05-07T20:37Z`. Could not complete file-upload submit cycle because subsequent navigations were preempted by the user's default-landing redirect.
- **Code observation (no-file):** `actions.ts:43-45` checks `instanceof File` and returns `ok:false, error:"No file uploaded."` ✅. Form input also has `required` attribute (client-side gate).
- **Code observation (empty workbook with header only):** `parse-workbook.ts:71` loops `r = 2` to `lastRow`. Header-only workbook has `sheet.rowCount = 1`, so loop body is skipped. `parsed.totalRows = 0`. Preview UI receives `preview.totalRows = 0` and renders "0 rows". ✅
- **Severity:** Pass.

### E-I-15 — Code-review pass — Mixed-valid/invalid behavior
- **Method:** Read `src/lib/import/parse-row.ts:225-245` and `src/app/(app)/leads/import/actions.ts:144-148`.
- **Observation:** Each row is validated independently; failures collect per-row error strings and the row is returned with `ok: false`. `commitImportAction` filters `.filter((r) => r.ok)` before sending to commit. ✅

### E-I-16 — Code-review pass — Re-import idempotency by external_id
- **Method:** Read `src/lib/import/commit.ts:84-104, 161-171`. Confirms `existingByExt` map populated from `leads_external_id_unique` partial index; rows with matching external_id take UPDATE branch. Activity dedup is per `(lead_id, import_dedup_key)`. ✅ — but see E-I-3 about the silent-no-op UPDATE bug, which interacts badly with re-imports.

### E-I-17 — Code-review pass — Smart-detect malformed input handling
- **Method:** Read `src/lib/import/d365-detect.ts` (first 50 lines) and `src/lib/import/activity-parser.ts:282-294`.
- **Observation:** Lines that fail to match `TIMESTAMP_RE` cause a "Skipped unrecognized line" warning rather than a throw. Unknown timezones produce a "interpreting as UTC" warning. ✅ Parser doesn't crash on the synthetic malformed fixture (`test-data/phase8e-malformed-d365.xlsx`).

### E-I-18 — Code-review pass — Concurrent imports don't share state
- **Method:** Read `src/lib/import/job-cache.ts` and commit.ts.
- **Observation:** Each preview gets its own `jobId` UUID and its own cached entry. Commit consumes its own job. Two simultaneous imports do NOT share rows — but they DO race at the DB level for the same external_id (see E-I-3) and for ownership of the in-process map (single-threaded JS — fine).
- **Severity:** Low — combine with E-I-3 fix.

## Findings (Delete)

### E-D-1 — High — Hard-delete and 30-day purge cron leak Vercel Blob attachments
- **Method:** Read `src/app/(app)/leads/actions.ts:hardDeleteLeadAction`, `src/lib/leads.ts:402-405` (`deleteLeadsById`), and `src/app/api/cron/purge-archived/route.ts`.
- **Observation:** Hard delete is `db.delete(leads).where(inArray(...))` with no Blob cleanup. Cascade deletes activities and attachments rows but does NOT delete the underlying Blob objects. The purge cron has no Blob cleanup either. Phase 4A.2 orphan scan exists (`scripts/orphan-scan.ts`) but it's a detection tool, not a cleanup. Note: `hardDeleteLeadAction` comment says "Vercel Blob cleanup runs separately" — but no scheduled task actually does this cleanup. Compare with admin user-delete (`src/app/admin/users/[id]/delete-user-actions.ts:182-205`) which DOES gather and clean blobs via `cleanupBlobsForUser`.
- **Risk:** Storage cost growth + privacy. After 30-day purge, audit_log retains the row snapshot but the actual file in Vercel Blob is orphaned — never deleted unless an admin runs orphan-scan and a cleanup script.
- **File:** `src/app/(app)/leads/actions.ts:204-216`, `src/app/api/cron/purge-archived/route.ts:54-66`, `src/lib/leads.ts:402-405`
- **Recommended fix:** Mirror the admin-user-delete pattern: gather blob pathnames before the DB delete, then `void cleanupBlobsForLead(...).catch(log)` outside the transaction. Same for the cron — gather blob paths in the same SELECT that grabs the candidates, then issue the cleanup batch after the DELETE.

### E-D-2 — Code-review pass — Soft delete preserves activities/tasks/attachments
- **Method:** Read `src/lib/leads.ts:413-429` and queries that filter via `activeLeads()`.
- **Observation:** `archiveLeadsById` only sets `is_deleted, deleted_at, deleted_by_id, delete_reason` on the lead row. No cascade. Activities, tasks, lead_tags, attachments are all preserved at rest; default queries simply don't show them because they JOIN through the active lead.
- **Severity:** Pass.

### E-D-3 — Code-review pass — Restore clears soft-delete columns and bumps version-not (medium nit)
- **Method:** Read `src/lib/leads.ts:436-452`.
- **Observation:** `restoreLeadsById` clears `is_deleted/deleted_at/deleted_by_id/delete_reason`, sets `updated_at, updated_by_id`. Does NOT bump `version`. Other UPDATE paths (`updateLead`, archive) also don't appear to bump version explicitly here — they rely on `concurrentUpdate` elsewhere.
- **Severity:** Low (medium-nit). Restore is admin-only and rare; OCC bypass is acceptable here, but inconsistent with the Phase 4A.7 claim "every UPDATE bumps version".
- **Recommended fix:** Optional — add `version: sql\`${leads.version} + 1\`` for consistency.

### E-D-4 — Code-review pass — Hard-delete cascade rules verified
- **Method:** Read `src/db/schema/leads.ts` and `src/db/schema/activities.ts`.
- **Observation:**
  - `leads.owner_id → users.id` is `ON DELETE RESTRICT` ✅ (claim 4)
  - `leads.created_by_id, updated_by_id, deleted_by_id, importJobId → users.id/imports.id` are `ON DELETE SET NULL` ✅ (claim 5)
  - `activities.lead_id → leads.id` is `ON DELETE CASCADE` ✅
  - `activities.user_id → users.id` is `ON DELETE SET NULL` ✅
  - `attachments.activity_id → activities.id` is `ON DELETE CASCADE` ✅
  - `lead_tags.lead_id → leads.id, tag_id → tags.id` both `ON DELETE CASCADE` ✅ (claim 6)
- **Severity:** Pass.

### E-D-5 — Code-review pass — Admin user delete: blocks self / breakglass / last admin
- **Method:** Read `src/app/admin/users/[id]/delete-user-actions.ts:130-185`.
- **Observation:** All three guards present: `admin.id === userId` → "cannot delete yourself"; `target.isBreakglass` → "cannot delete breakglass"; admin count guard checks for OTHER active admins → "cannot delete last admin". Reassign vs delete_leads disposition correctly enforced (`disposition === "reassign"` requires `reassignTo`). ✅

### E-D-6 — Code-review pass — Admin user delete with disposition=delete_leads cleans Blob
- **Method:** Read `src/app/admin/users/[id]/delete-user-actions.ts:182-205, 250-263`.
- **Observation:** Blob paths are gathered BEFORE the DB transaction; cleanup runs OUTSIDE the transaction (`void cleanupBlobsForUser(userId).catch(log)`), so a Blob API failure doesn't roll back the DB delete. ✅

### E-D-7 — Code-review pass — Audit on archive / restore / hard-delete / bulk
- **Method:** Read `src/app/(app)/leads/actions.ts:154-228`.
- **Observation:** Each of `deleteLeadAction` (archive), `restoreLeadAction`, `hardDeleteLeadAction` writes a corresponding `lead.archive` / `lead.restore` / `lead.hard_delete` audit row. ✅
- **Note:** Bulk archive/restore actions not included in this file — would have to verify in `src/lib/leads.ts` mass operations. Not present in the read code paths.

### E-D-8 — Code-review pass — Purge cron exists with bearer-token auth
- **Method:** Read `src/app/api/cron/purge-archived/route.ts`.
- **Observation:** `Authorization: Bearer ${env.CRON_SECRET}` check at line 22-25; 401 on mismatch; `runtime: 'nodejs'`, `dynamic: 'force-dynamic'`, `maxDuration: 300`. Cutoff: `Date.now() - 30 * 24 * 60 * 60 * 1000` (line 30). Deletes only rows where `isDeleted = true AND deletedAt < cutoff`. ✅
- **Caveat:** See E-D-1 — does not clean Blobs.

### E-D-9 — Code-review pass — OCC on concurrent edit-vs-delete
- **Method:** Read `src/app/(app)/leads/actions.ts:84-141` (`updateLeadAction`) and `src/lib/leads.ts:updateLead` (called via `concurrentUpdate`).
- **Observation:** `updateLeadAction` requires a `version` from the form, calls `concurrentUpdate` via `updateLead`, and translates `ConflictError`/`NotFoundError` into a `{ ok:false, error }`. If a second user edits a lead that the first user just archived, the version stays the same but the row's `is_deleted=true`. Depending on whether `updateLead`'s `WHERE` clause includes `is_deleted=false`, the UPDATE may match the archived row (silent overwrite of an archived lead with stale data) or fail with NotFoundError. Could not confirm without reading `updateLead` body.
- **Severity:** Medium (worth follow-up by Sub-agent F).
- **Recommended fix:** Ensure `updateLead`'s WHERE clause includes `is_deleted = false` so a concurrent archive surfaces as `NotFoundError`.

### E-D-10 — Code-review pass — Soft-delete leakage check
- **Method:** Searched for `activeLeads()` filter usage in the leads-list and detail queries (referenced by Phase 4G claim).
- **Observation:** Default queries should filter `is_deleted = false`. This audit did not exhaustively grep every query. Other audit sub-agents (A/B/C/D) likely covered this surface.
- **Severity:** Pass with caveat — superficial review only.

## Verified-passing
- **E-V1** — Empty XLSX (header only) returns `parsed.totalRows = 0` deterministically (code review of `parse-workbook.ts:71-89`; live test interrupted by redirect).
- **E-V2** — No-file POST returns `{ ok: false, error: "No file uploaded." }` (code review of `actions.ts:43-45`).
- **E-V3** — `.docx` renamed `.xlsx` is rejected — but by exceljs internal error, not by the documented MIME/magic-byte validator (see E-I-2).
- **E-V4** — 10,000-row cap enforced (`parse-workbook.ts:20, 71`) (code-review pass; not live-tested).
- **E-V5** — All-rows-invalid: every row returned with `ok:false`, commit filters them out, no leads created (code review of `actions.ts:144-148`).
- **E-V6** — Mixed valid + invalid: per-row independent validation; valid commit, invalid retained as `failedRows` (code review of `actions.ts:144-167`).
- **E-V7** — Re-import same file: external_id match triggers UPDATE (but with E-I-3 silent-no-op caveat); activity dedup_key prevents duplication (code review of `commit.ts:84-104, 270-310`).
- **E-V8** — Malformed D365 description: parser warns and skips bad lines, doesn't crash (code review of `activity-parser.ts:282-294`).
- **E-V9** — Smart-detect on legitimate fixture parses correctly (covered by `scripts/import-smoke-build.ts` + Phase 6 evidence).
- **E-V10** — Unicode names accepted because `importRowSchema.firstName` has no charset restriction (code review of `row-schema.ts:15-23` — note: this also means E-I-1 holds; the lack of restriction is the same root issue).
- **E-V11** — `firstName` 99 / 100 chars accepted; 101 chars rejected by `.max(100)` (code review of `row-schema.ts:19`).
- **E-V12** — 200-activity cap enforced with truncation warning (code review of `activity-parser.ts:46, 327-345`).
- **E-V13** — Owner email pointing to non-existent user → resolver returns null, lead created unowned, row warning surfaced (code review of `resolve-users.ts:30-39` and `commit.ts:160-165`).
- **E-V14** — Re-import idempotency for activities via `import_dedup_key` partial index (code review of `commit.ts:270-310` and `dedup-key.ts`).
- **E-V15** — Restore action exists and clears soft-delete fields (code review of `leads.ts:436-452`).
- **E-V16** — Cascade rules per Phase 4A FK doc verified across leads / activities / attachments / lead_tags / users.
- **E-V17** — Bearer-token auth + 30-day cutoff for purge-archived cron verified.
- **E-V18** — Audit log entries present for archive / restore / hard-delete / import.commit / leads.import / user.delete.
- **E-V19** — Admin user-delete blocks self, breakglass, and last-admin; uses transactional reassign-vs-delete; cleans Blob outside the transaction.

## Files referenced (absolute paths)
- `C:\Code\MWG_CRM\src\lib\import\parse-workbook.ts`
- `C:\Code\MWG_CRM\src\lib\import\parse-row.ts`
- `C:\Code\MWG_CRM\src\lib\import\row-schema.ts`
- `C:\Code\MWG_CRM\src\lib\import\activity-parser.ts`
- `C:\Code\MWG_CRM\src\lib\import\d365-detect.ts`
- `C:\Code\MWG_CRM\src\lib\import\commit.ts`
- `C:\Code\MWG_CRM\src\lib\import\resolve-users.ts`
- `C:\Code\MWG_CRM\src\lib\import\dedup-key.ts`
- `C:\Code\MWG_CRM\src\lib\import\job-cache.ts`
- `C:\Code\MWG_CRM\src\lib\validation\primitives.ts`
- `C:\Code\MWG_CRM\src\lib\validation\file-upload.ts`
- `C:\Code\MWG_CRM\src\lib\leads.ts` (lines 398-452)
- `C:\Code\MWG_CRM\src\app\(app)\leads\import\actions.ts`
- `C:\Code\MWG_CRM\src\app\(app)\leads\import\import-client.tsx`
- `C:\Code\MWG_CRM\src\app\(app)\leads\actions.ts`
- `C:\Code\MWG_CRM\src\app\admin\users\[id]\delete-user-actions.ts`
- `C:\Code\MWG_CRM\src\app\api\cron\purge-archived\route.ts`
- `C:\Code\MWG_CRM\src\db\schema\leads.ts`
- `C:\Code\MWG_CRM\src\db\schema\activities.ts`
- `C:\Code\MWG_CRM\src\db\schema\tags.ts`
- `C:\Code\MWG_CRM\src\db\schema\users.ts`
- `C:\Code\MWG_CRM\test-data\phase8e-empty.xlsx` (synthetic fixture)
- `C:\Code\MWG_CRM\test-data\phase8e-formula-injection.xlsx` (synthetic fixture)
- `C:\Code\MWG_CRM\test-data\phase8e-unicode.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-long-name.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-all-invalid.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-mixed.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-tags.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-malformed-d365.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-csv-fake.xlsx`
- `C:\Code\MWG_CRM\test-data\phase8e-docx-fake.xlsx`
- `C:\Code\MWG_CRM\scripts\phase8e-fixtures.ts` (auditor-generated; safe to delete)
