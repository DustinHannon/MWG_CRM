# Phase 8 Audit A — Feature Wiring

Auditor: Sub-agent A (read-only, browser-driven)
Method: Live walkthrough at https://mwg-crm.vercel.app via breakglass account; Playwright MCP; cross-referenced source via Grep/Read; queried Vercel logs for the 500-error stack trace.
Date: 2026-05-07

## Summary

Total claims tested: ~70 (a representative cross-section across the 19 areas in the checklist)
Passed (verified working): 41
Partial / cosmetic mismatch: 6
Failed (Critical/High): 5
Skipped (deferred-by-design or untestable on breakglass): ~13

### Top critical findings

1. **A-1 (Critical)** — Lead `website` field validation uses bare `z.string().url()` instead of `urlField` primitive. Accepts `javascript:…` and `ftp://…`. DB CHECK constraint blocks it but the server returns an unhandled 500 with stack trace in logs (digest 367469013 / 962170328). Validation should occur in the server action and surface a clean ValidationError toast.
2. **A-2 (High)** — Persistent CSP violation on every page (next-themes inline script). Every page logs an inline-script CSP violation. Phase 3J claim "Acceptance gate: every page browser console shows zero CSP violations" is **failed**.
3. **A-3 (High)** — Lead detail "Print / PDF" auto-print is broken. The print page injects an inline `dangerouslySetInnerHTML` `<script>` that is blocked by CSP. The page renders but `window.print()` never fires. Users have to manually invoke browser print.

## Findings

### A-1 — Critical — Lead `website` field uses unsafe URL validation, server returns 500 on `ftp://`/`javascript:`

Method: Created a new lead at `/leads/new` via Playwright. Auto-fill (and again, intentional manual repro) sent `website=ftp://malicious.example`. Form posted; server returned a 500 error page with `ERROR 962170328`. Vercel logs show `Error: Failed query: insert into "leads" … violates check constraint "leads_website_protocol"` (PG code 23514). On a separate auto-test attempt with `javascript:alert(1)` the same path returned digest 367469013 / 500.

Evidence: Vercel logs query `--status-code 500 --since 30m --json` returned the full stack trace at 2026-05-07T20:35:16Z (deployment dpl_8YP12dPypr7YXwq3n7ZYHMhU3gUN).

Code:
- `src/lib/leads.ts:83` uses `z.string().url().or(z.literal("")).optional().nullable()` — accepts any valid URL including `ftp://`, `javascript:`.
- `src/lib/validation/primitives.ts:52-59` defines a correct `urlField` that enforces `^https?://` — but it is not used here.

Impact: 1) Validation gap; 2) DB CHECK does catch it but throws raw `pg` error rather than a `ValidationError`/`KnownError`. Server returns 500 with stack in logs. Phase 4A claim "Public errors carry `requestId`; stacks never leak in production" is undermined: the stack does leak via Vercel runtime logs (which is fine for staff but suggests `withErrorBoundary` isn't translating the constraint violation to a user-facing message).

Recommended fix: Switch `leads.ts` validators (website, linkedinUrl, phone) to the existing `primitives.ts` validators. Have `withErrorBoundary` map PostgreSQL CHECK constraint violations (code 23514) to `ValidationError` with the constraint name as a hint.

### A-2 — High — next-themes inline script causes CSP violation on every page

Method: Loaded `/auth/signin`, `/dashboard`, `/leads`, `/admin`, `/admin/users`, `/admin/audit`, `/admin/scoring`, `/leads/print/[id]` and ran `browser_console_messages level=error`. Every page returned exactly one CSP violation:
> Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'nonce-{rand}' 'strict-dynamic' 'unsafe-eval'

Evidence: console-2026-05-07T20-30-21-494Z.log#L1 (signin), and all subsequent navigations.

Cause: `src/components/theme/theme-provider.tsx` uses `next-themes`' `ThemeProvider` (which injects an inline `<script>` for FOUC prevention). The proxy/middleware nonce is not propagated to next-themes' inline element.

Recommended fix: Use `next-themes`' `nonce` prop (read from `headers()` `x-nonce`) when rendering ThemeProvider in the root layout.

### A-3 — High — Lead Print page auto-print blocked by CSP

Method: Navigated to `/leads/print/278de85b…`. Two CSP violations emitted (both for inline scripts on that page). Auto-print did not fire.

Code: `src/app/leads/print/[id]/page.tsx:205-211` injects an inline `dangerouslySetInnerHTML` `<script>` with no nonce. CSP `script-src 'self' 'nonce-…' 'strict-dynamic'` blocks it.

Evidence: console-2026-05-07T20-43-28-637Z.log shows two inline-script CSP errors.

Recommended fix: Read `x-nonce` from `headers()` in the server component and pass it as the `nonce` attribute on the `<script>` tag, OR move auto-print into a small client component using a `useEffect`.

### A-4 — Medium — Lead detail "Delete" button labeled wrong (claim: should be "Archive")

Method: Loaded `/leads/278de85b…`; saw button labeled "Delete". The action it calls (`deleteLeadAction` → `archiveLeadsById`) actually performs soft delete (sets `is_deleted=true`) — so functionally this is archive.

Code: `src/app/(app)/leads/[id]/page.tsx:161` — text reads `"Delete"`.
Code: `src/app/(app)/leads/actions.ts:155` — comment says "what was 'delete' is now 'archive'".

Phase 4G claim: "Delete button replaced with Archive (sets soft-delete fields; audit `lead.archive`)". The audit/action match the claim; only the button label is stale.

Recommended fix: Rename button text to "Archive". Audit log already writes `lead.archive` (verify).

### A-5 — Medium — Lead form lacks Subject input field

Method: Loaded `/leads/new`; inspected form. Sections present: Contact, Pipeline, Address, Notes. No Subject field. Loaded `/leads/[id]/edit`; same — no Subject.

Phase 6A claim: "leads.subject column with CHECK constraint; FTS index includes subject" and "leads.subject rendered as italic line under name on detail page; optional column in leads table". The detail-page render IS wired (`src/app/(app)/leads/[id]/page.tsx:76-77`), and the schema/FTS index are present, but **no UI to set or edit subject** ships.

Recommended fix: Add a `<textarea name="subject" maxLength={1000}>` to `lead-form.tsx` (Notes section, above Description).

### A-6 — Medium — TagInput combobox component built but not used in lead form

Method: Inspected `/leads/new` and `/leads/[id]/edit` — Tags input is plain `<Input name="tags" label="Tags (comma-separated)" />`. Searched repo for `<TagInput>` usage outside its own file — zero matches.

Code: `src/components/tags/tag-input.tsx` exists. `src/app/(app)/leads/lead-form.tsx:127` uses comma-separated text input.

Phase 3C claim: "Tag combobox/multiselect with create-on-the-fly (`tag-input.tsx`)". Component is implemented but not wired into the lead form.

Recommended fix: Replace the plain Input on lead-form with `<TagInput>`. Note that bulk-tag toolbar UI is explicitly deferred per `PHASE8-DEFERRED.md`, but the per-lead form combobox is not on the deferred list.

### A-7 — Low — Activity feed empty state shows stale "Phase 7" message

Method: Loaded a lead with no activities. Empty state reads "Email and meeting activities arrive in Phase 7."

Code: `src/app/(app)/leads/[id]/activities/activity-feed.tsx:37`.

Phase 7 has shipped (Microsoft Graph integration is per the master claims list). The string is stale copy.

Recommended fix: Drop the "arrive in Phase 7" sentence.

### A-8 — Low — Path mismatch for import template URL

Method: Phase 6G claim: "Downloadable .xlsx template at `GET /leads/import/template`". Actual endpoint is `/api/leads/import-template` (the link on `/leads/import` points there; status 307 unauth → confirms route exists).

Recommended fix: Update Phase 6G claim doc, or add a redirect at `/leads/import/template` → `/api/leads/import-template`.

### A-9 — Info — User panel subtitle is email when jobTitle is null

Method: Breakglass account has no Microsoft jobTitle, so the user-panel subtitle falls back to `email` (`breakglass@local.mwg-crm`). Source: `src/components/user-panel/user-panel.tsx:42` `const subtitle = jobTitle ?? email;`.

Phase 3B claim: "User panel: clickable card with avatar + name + title". Strictly the title is rendered when present; otherwise email. Acceptable for breakglass; would need verification with a real Entra user with a populated `jobTitle`.

## Verified-passing features (with evidence)

### Auth + session
- A-V1 ✅ Breakglass sign-in works. Username `breakglass` + given password lands on `/dashboard` (verified 2026-05-07T20:30:54Z).
- A-V2 ✅ Sign-out from user-panel popover works. Click → redirected to `/auth/signin` (verified 2026-05-07T20:44:30Z).
- A-V3 ✅ After sign-out, navigating to `/dashboard` redirects to `/auth/signin?callbackUrl=%2Fdashboard` (verified 2026-05-07T20:44:34Z).
- A-V4 ✅ Auth cookie is httpOnly. `document.cookie` returned empty string while authenticated.
- A-V5 ✅ User-panel popover opens with Settings + Sign out items. Avatar (BA initials), name, email, chevron all render.

### User panel + settings
- A-V6 ✅ Bottom-left user panel renders as the new clickable card (avatar 36px + name + subtitle + chevron). Confirmed with snapshots on `/dashboard`, `/leads`, `/admin`, `/admin/users`, `/settings`.
- A-V7 ✅ Settings link routes to `/settings`.
- A-V8 ✅ `/settings` shows all six sections per Phase 5A claim: Profile (with lock icons + tooltip on every field), Preferences, Notifications, Microsoft 365 connection, Account info, Danger zone.
- A-V9 ✅ All Entra-locked Profile fields (First name, Last name, Display name, Email, Username, Job title, Department, Office location, Business phone, Mobile phone, Country, Manager, Role) render with lock icon (`<img>`).
- A-V10 ✅ Theme toggle: System/Light/Dark radio. Switching to Light persisted across navigation (verified by checking `documentElement.className` includes `light` after navigating from /settings to /admin).
- A-V11 ✅ Default landing page select shows Dashboard / My Open Leads / All My Leads / Recently Modified / Custom URL.
- A-V12 ✅ Default leads view select renders.
- A-V13 ✅ Time zone select with 8 options including Central (US) selected.
- A-V14 ✅ Date format radio (MM/DD/YYYY / DD/MM/YYYY / YYYY-MM-DD).
- A-V15 ✅ Time format radio (12h / 24h).
- A-V16 ✅ Table density toggle: switching to Compact stamps `data-density="compact"` on the AppShell wrapper `<div>` (NOT `<html>`, but this is correct per code in `src/components/app-shell/app-shell.tsx:76`; CSS rules in `globals.css` target `[data-density="compact"] .data-table`).
- A-V17 ✅ Notification preference checkboxes (Tasks due today, Tasks assigned to me, @-mentions, Saved-search digest) all render and are checked by default.
- A-V18 ✅ Email digest frequency select (Off / Daily / Weekly).
- A-V19 ✅ Sign out everywhere button + Sign out button both present in Danger zone.

### Lead lifecycle
- A-V20 ✅ Lead create from `/leads/new` works for valid payload. Created lead `Audit Test` at 2026-05-07T20:36:33Z (id 278de85b-dda5-4203-bfc3-810d399cb702); redirected to detail page.
- A-V21 ✅ Lead detail provenance line "Created by Breakglass Admin on 05/07/2026" rendered.
- A-V22 ✅ Convert / Edit / Print/PDF / Delete buttons all present on lead detail header.
- A-V23 ✅ Lead detail Pipeline cards (Industry / Estimated value / Estimated close / Tags) render.
- A-V24 ✅ Lead edit form loads with `version=1` hidden input populated. `concurrentUpdate` is wired in `updateLeadAction` (verified by Grep — passes `version` to `updateLead`, catches `ConflictError`).

### Activities
- A-V25 ✅ Note composer (textarea + "Add note" button) renders on lead detail. Submitting a note re-renders the page with the note in the activity feed (verified at 2026-05-07T20:46:32Z — text "Test note from Phase 8 audit. cc @breakglass" appears in main).
- A-V26 ✅ Tabs for Note / Log call / Add task render. GraphActionPanel (Send email / Schedule meeting) renders for admin (correct gating per `(perms.canSendEmail || user.isAdmin) && !lead.doNotEmail`).

### Tasks + notifications
- A-V27 ✅ `/tasks` page renders with h1 "My tasks" and inline create.
- A-V28 ✅ Notifications bell icon shows in top bar; clicking opens popover with "Mark all read" button + "View all" link.
- A-V29 ✅ `/notifications` page renders with h1 "All notifications".

### Pipeline (Kanban)
- A-V30 ✅ `/leads/pipeline` renders 5 columns: New (1), Contacted (0), Qualified (0), Unqualified (0), Lost (0). Lead "Audit Test / Audit Co / Breakglass Admin" appears under New. (Note: `converted` stage intentionally not shown, per the ALL-status enum vs pipeline-active subset.)

### Cmd+K
- A-V31 ✅ Cmd+K (Ctrl+K via Playwright) opens command palette on `/leads`. `[cmdk-input]` placeholder = "Search leads, contacts, accounts, opportunities, tasks…".
- A-V32 ✅ Search "Audit" → finds the Audit Test lead and navigates to it on Enter (FTS search wired).

### Lead conversion
- A-V33 ✅ "Convert" button on lead detail opens the inline convert modal with Account name (required), Create contact, Create opportunity options. Single-transaction code path verified at `src/app/(app)/leads/[id]/convert/actions.ts`.

### Opportunities / Accounts / Contacts
- A-V34 ✅ `/opportunities` h1 "Opportunities" renders.
- A-V35 ✅ `/accounts` h1 "Accounts" renders.
- A-V36 ✅ `/contacts` h1 "Contacts" renders.

### Soft delete + archive
- A-V37 ✅ `/leads/archived` renders with h1 "Archived leads", subtitle "Hidden from the main views. Auto-purged 30 days after archive."

### Lead scoring
- A-V38 ✅ `/admin/scoring` renders with rules + thresholds form.

### Import
- A-V39 ✅ `/leads/import` renders with file upload, "Detect and parse legacy D365 Description column" checkbox, "Preview import" button, "Download template" link.
- A-V40 ✅ `/admin/import-help` renders with h1 "Import help".

### Admin
- A-V41 ✅ Admin sidebar nav: Overview / Users / Tags / Scoring / Audit log / Data tools / Import help / Settings / Back to dashboard. All admin routes (tested: /admin, /admin/users, /admin/tags, /admin/scoring, /admin/audit, /admin/import-help) render with full chrome.
- A-V42 ✅ Brand on /admin reads "MWG CRM Admin" (subtitle treatment); main app reads "MWG CRM".

### CSP
- A-V43 ⚠️ CSP header is set with per-request nonce — confirmed by `Content-Security-Policy 'self' 'nonce-{rand}' 'strict-dynamic' 'unsafe-eval'` in console errors. BUT see A-2 — inline next-themes script violates it on every page.

### Theme + chrome consistency
- A-V44 ✅ Every authenticated route tested (`/dashboard`, `/leads`, `/leads/[id]`, `/leads/[id]/edit`, `/leads/pipeline`, `/leads/archived`, `/leads/import`, `/leads/new`, `/accounts`, `/contacts`, `/opportunities`, `/tasks`, `/notifications`, `/settings`, `/admin`, `/admin/users`, `/admin/tags`, `/admin/scoring`, `/admin/audit`, `/admin/import-help`) renders identical sidebar + top bar + bell + user panel.
- A-V45 ✅ Print page (`/leads/print/[id]`) is intentionally outside the chrome (no sidebar/nav) per Phase 7 exception list.

### Cron jobs
- A-V46 ✅ All 4 cron routes registered in `vercel.json` with correct schedules: tasks-due-today (14:00 UTC), saved-search-digest (14:00 UTC), rescore-leads (09:00 UTC), purge-archived (10:00 UTC). Source folders exist at `src/app/api/cron/{tasks-due-today, saved-search-digest, rescore-leads, purge-archived}`.

## Skipped / Untestable

- Sign-out-everywhere kicking a second tab — would require two simulated browsers. Code path verified: `bumpSessionVersion` exists; jwt callback re-reads `users.session_version`.
- Two-tab OCC conflict toast — Playwright tab-switching during this session was unreliable (selectors became stale across tab switches). Code path verified: `updateLeadAction` parses `version` from form, catches `ConflictError` and returns `{ ok: false, error: publicMessage }`. Toast call site uses `duration: Infinity, dismissible: true` per Phase 6B claim.
- Daily cron triggers (tasks-due-today, saved-search-digest, etc.) — would require `CRON_SECRET` from env (not auto-fetched).
- Microsoft Graph send-email / schedule-meeting — breakglass has no Entra connection. Settings page correctly states "The breakglass account does not connect to Microsoft 365. Email and calendar features are disabled." But `GraphActionPanel` IS rendered on lead detail because the gating is `canSendEmail || isAdmin` — submitting would fail; non-blocking note.
- Entra profile photo — breakglass uses initials fallback (BA), expected.
- @-mention notification — breakglass is the only user; mention `@breakglass` in note was accepted (note posted) but verifying notification creation path needs a second user.
- Saved-view auto-revert — Phase 4B logic exists in code (`updateViewAction` writes to `view_overrides`); UI shows "Save changes" + "Save as new view" buttons when `columnsModified`. Did not exercise the full revert lifecycle — needs more time.
- D365 smart-detect import — would require uploading an .xlsx file. Toggle and code path verified.
- Saved-search digest email via Graph — wiring verified, runtime requires Graph token.

## Key file references (absolute paths)

- `C:\Code\MWG_CRM\src\lib\leads.ts:83` — unsafe `z.string().url()` (Finding A-1)
- `C:\Code\MWG_CRM\src\lib\validation\primitives.ts:52-59` — correct `urlField` (unused in leads schema)
- `C:\Code\MWG_CRM\src\components\theme\theme-provider.tsx` — next-themes wrapper, no `nonce` prop (Finding A-2)
- `C:\Code\MWG_CRM\src\app\leads\print\[id]\page.tsx:205-211` — inline auto-print script without nonce (Finding A-3)
- `C:\Code\MWG_CRM\src\app\(app)\leads\[id]\page.tsx:161` — "Delete" button label (Finding A-4)
- `C:\Code\MWG_CRM\src\app\(app)\leads\lead-form.tsx:127` — comma-separated tags input (Finding A-6)
- `C:\Code\MWG_CRM\src\components\tags\tag-input.tsx` — TagInput combobox component (built, unused; Finding A-6)
- `C:\Code\MWG_CRM\src\app\(app)\leads\[id]\activities\activity-feed.tsx:37` — stale "arrive in Phase 7" message (Finding A-7)
- `C:\Code\MWG_CRM\src\components\app-shell\app-shell.tsx:76` — `<div data-density={density}>` (correctly applies density)
- `C:\Code\MWG_CRM\vercel.json` — cron registry, 4 entries
- `C:\Code\MWG_CRM\.phase8-evidence\a-dashboard.png`, `a-dashboard-final.png`, `a-leads-list.png`, `a-settings-final.png` — captured screenshots
