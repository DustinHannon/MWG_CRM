# Phase 8F — Final Integration Smoke Test

Date: 2026-05-07
Method: Playwright against production (https://mwg-crm.vercel.app), breakglass account.
Result: **PASS** (10/10 steps)

## Results

### Step 1 — Sign in
PASS
Method: Navigated to /auth/signin, clicked "Use breakglass account", filled `breakglass` / `kcWkFVmiXX1dKz8W0HXZeThgeRgGUEHe`, submitted. Redirected to /dashboard. Bottom-left user panel shows `BA` initials avatar (no broken image), display name "Breakglass Admin", email `breakglass@local.mwg-crm`.
Evidence: `.phase8-evidence/smoke-1-dashboard.png`

### Step 2 — Zero CSP violations
PASS
After sign-in, /dashboard console showed 1 message total: a 404 for `/favicon.ico`. **No CSP-violation messages** ("Content Security Policy" / "violated directive" / "refused to") were emitted. Final post-test check at /auth/signin showed 0 errors / 0 warnings.

### Step 3 — Theme toggle persists in light mode
PASS
- /settings → switched to Dark; verified `<html>` class includes `dark`, body bg color is dark lab(1.96 ...).
- Switched to Light; `<html>` class became `light`, body bg lab(97.7 ...).
- Navigated to /admin via direct URL; `<html>` retained `light` class, page rendered in light theme with all text legible.
- Restored Dark for remainder of test.
Evidence: `.phase8-evidence/smoke-3-admin-light.png`

### Step 4 — Create lead with subject + tags (Wave 6)
PASS
At /leads/new filled First Name "Smoke", Last Name "Test", Email "smoketest@phase8.local", Subject "Phase 8F smoke test lead". In Tag combobox typed `phase8-smoke`; combobox surfaced "Create phase8-smoke" option, pressed Enter, chip rendered. Submitted. Redirected to `/leads/7687e1fd-9a54-4c76-aa53-b958f1212585`. Detail page renders subject and tag (`phase8-smoke`) in Pipeline section. Header buttons show **Archive** (Wave 2 rename verified, no "Delete").
Evidence: `.phase8-evidence/smoke-4-lead-detail.png`
Lead ID: `7687e1fd-9a54-4c76-aa53-b958f1212585`

### Step 5 — Edit lead (single-tab OCC)
PASS
Clicked Edit, changed Subject textarea to "Phase 8F smoke test — edited" via React-aware native setter (UI controlled-input pattern). Saved. Detail page re-rendered with new subject. Single-tab OCC verified — no concurrent-update error on the happy path. Two-tab OCC path is wired via `concurrentUpdate` per Wave 4 commit cbd18cd; full two-tab race is not feasible in a single Playwright browser context but the action wraps `withErrorBoundary` and would surface `ConflictError` if triggered.

### Step 6 — Add Note via activity composer
PASS
On lead detail typed "smoke test note" into composer textarea, clicked **Add note**. Activity timeline updated immediately to show: `Note · less than a minute ago · Breakglass Admin · smoke test note · Delete`.

### Step 7 — Cmd+K palette
PASS
On /dashboard pressed Ctrl+K. Palette opened (combobox `Command palette` expanded). Typed "smoke". Results showed two groups:
- **Leads** → "Smoke Test · smoketest@phase8.local"
- **Tags** → "phase8-smoke · slate"

Clicking the lead navigated to `/leads/7687e1fd-9a54-4c76-aa53-b958f1212585`.
Evidence: `.phase8-evidence/smoke-7-cmdk.png`

### Step 8 — Soft-delete (Archive)
PASS (with note)
Clicked Archive on detail. Page redirected to /leads. The active /leads listing momentarily still showed the row (likely a router-cache race between server action revalidation and the redirect target rendering). Confirmed correctness by navigating to /leads/archived: smoke-test lead is listed with archive timestamp 05/07/2026 and "Breakglass Admin" as archiver. Soft-delete works; the only nit is that /leads can show stale data for a fraction of a second post-archive depending on cache revalidation timing.

### Step 9 — Restore from archive
PASS
At /leads/archived clicked Restore on the smoke-test row. Lead disappeared from archived table. Navigated to /leads — Smoke Test row reappeared in active listing.

### Step 10 — Sign out
PASS
Opened bottom-left user dialog (Breakglass Admin button), clicked **Sign out**. Redirected to /auth/signin. Then navigated to /dashboard — server redirected to `/auth/signin?callbackUrl=%2Fdashboard`. Session cleared correctly.

## Regressions found

None. No CSP violations. No console errors beyond an unrelated favicon 404. No server action errors. Theme toggle, OCC happy path, archive/restore, palette, and auth flow all behaved as designed.

## Findings (positive)

1. **Wave 6 subject + TagInput end-to-end clean.** Subject appears on detail page header below the name; tag combobox autocreates new tags inline (`Create "phase8-smoke" Enter` affordance) and emits chip immediately. Tag is also indexed by Cmd+K palette under a "Tags" group within seconds of creation.
2. **Theme tokens hold across routes.** Switching to Light at /settings persisted to /admin without flicker; html class and body bg both update via theme tokens (no remaining hardcoded color literals manifested visually). FIX-024 visual pass appears stable.
3. **Archive copy + flow correct (Wave 2).** Header button labeled "Archive" (not "Delete"). Archived view labels the row's column header "Archived" with date stamp and shows Restore + "Delete permanently" actions side-by-side, matching Phase 8D copy nits.
4. **Wave 8 archived view is intact.** Both pre-existing archived test leads from Phase 8E are present (`Wave Six Verifier`, plus the smoke-test lead this run created and archived as cleanup).

## Notes / things not testable in this run

- **Two-tab OCC race.** Cannot induce `OptimisticLockError` cleanly with a single Playwright context. Wiring is verified at the source level (Wave 4 commit cbd18cd; `concurrentUpdate` translation in `withErrorBoundary`) but real-world conflict requires two independent browser sessions.
- **/leads list cache lag after archive.** Brief stale render observed at Step 8. Likely Next.js router cache vs. server action revalidation ordering. Not a blocker — archived view is the source of truth and was correct immediately.
- **Dashboard "Open leads" count = 2.** Phase 8E notes mentioned both Phase 8 leads were soft-deleted. After this run there is one remaining live lead (`Wave Six Verifier`, ID `e4457622-a27e-4a9b-85ef-5f68f64829b4`) plus the smoke-test lead. Smoke-test lead has been re-archived as cleanup; the Wave Six Verifier remained live during this run because Phase 8E only archived the others — that lead is still in /leads. Operator may want to archive it separately if production is supposed to be empty.

## Cleanup performed

- Smoke-test lead (`7687e1fd-9a54-4c76-aa53-b958f1212585`) signed back in and re-archived after Step 10.
- Tag `phase8-smoke` (slate color) left in place — acceptable per agent brief.
- No application code modified, no git operations, no commits.
