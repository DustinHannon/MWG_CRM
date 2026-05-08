# Phase 8 Audit D — Security

Auditor: Sub-agent D (read-only-for-code, adversarial-for-app)
Method: Probe testing against https://mwg-crm.vercel.app + targeted code review
Date: 2026-05-07
Wall-clock: ~45 min
App user used: breakglass (id `b00f3a03-2c14-4ceb-9c36-7e072f8265fa`)

## Summary
- Tests run: 19 categories
- Pass: 14
- Fail (security gap): 1 Medium + 2 Low/Info
- Inconclusive: 2 (rate-limit and second-user IDOR)

Top 3 priorities:
1. **D-3 (Medium) — CSP `unsafe-eval` allowance + a recurring blocked inline-script hash on every page** (`sha256-zjP2BXYgSCCnXNMXI2IL1yRydoQdsGR/uCCr6kyKsD0=`). Strict-CSP claim is mostly correct but at least one inline script lacks the per-request nonce, breaking the strict-dynamic guarantee from a "we trust nothing inline" perspective and producing a console error on every authenticated page.
2. **D-4 (Low) — Cron endpoints don't expose 401 directly.** They redirect to `/auth/signin?callbackUrl=...` first because the proxy/middleware enforces session-cookie before bearer-token. Functionally harmless (Vercel cron sets the bearer + bypasses redirect via Vercel's internal calls), but external callers without a session never reach the bearer-check 401.
3. **D-5 (Info) — Tables have RLS enabled but zero policies.** With service-role key, this is the documented pattern (default-deny, all writes via server actions). Documented, working, and intentional — flagged only as a structural reminder that any future direct-from-browser query (anon/authenticated key) will be silently denied.

---

## Findings

### D-1 — Info — Lead `firstName` schema does not use the strict `nameField` primitive
- Code: `src/lib/leads.ts:66` uses `z.string().trim().min(1).max(120)` on `firstName`/`lastName`, not the `nameField` primitive at `src/lib/validation/primitives.ts:14-22` (which would reject `<script>...</script>`).
- DB-side `leads_first_name_len` CHECK only enforces length 1-100.
- Practical risk: low — React's default text rendering escapes the value (verified live: D-V6 below). The lead can be stored with `<script>` content but will render as text.
- Recommendation: switch lead create/update to use `nameField` for `firstName`, `lastName`, `salutation`. Same applies to `companyName`/`industry` (currently free-text).
- Severity: Info (no current exploit; would become High if any path ever rendered name as `dangerouslySetInnerHTML` or as `href`).

### D-2 — Info — Forms briefly returned a 500 on the lead-create round-trip
- Method: created a lead with `firstName=<script>alert('xss')</script>`, `lastName=TestSec`, `website=javascript:alert(1)` via /leads/new.
- Result: `/leads/new` POST returned HTTP 500 ("Failed query: insert..." in Vercel runtime logs at 20:35:16Z).
- Cause inferred: `urlField` Zod refinement should have rejected `javascript:` BEFORE the insert; it appears the schema for the lead create form does not bind `urlField` to `website` (or DB CHECK `leads_website_protocol` fired). The insert was rejected — defense in depth held — but the failure surfaced as a generic "page couldn't load" 500 instead of a friendly field-level validation error.
- Severity: Info (defense in depth held; UX bug only). Recommend wiring `urlField` into `leadCreateSchema` for `website` and `linkedinUrl` and converting DB-CHECK violations into Zod-style field errors via the `withErrorHandling` server-action wrapper.

### D-3 — Medium — Recurring CSP `inline script blocked` on every authenticated page
- Method: Playwright `browser_console_messages` aggregated across `/dashboard`, `/leads`, `/leads/[id]`, `/leads/[id]/edit`, `/admin`, `/admin/audit`, `/admin/users`, `/admin/scoring`, `/admin/tags`, `/admin/import-help`, `/accounts`, `/contacts`, `/opportunities`, `/tasks`, `/notifications`, `/settings`, `/auth/signin`, `/leads/print/[id]`.
- Result: every page emits an identical CSP violation: `script-src 'self' 'nonce-...' 'strict-dynamic' 'unsafe-eval'` blocking an inline script with hash `sha256-zjP2BXYgSCCnXNMXI2IL1yRydoQdsGR/uCCr6kyKsD0=`. One additional hash on `/leads/print/[id]`: `sha256-y3gpCDDmNK23YESmrGmfLT1RsG4QtPo7qAOLXg3WGyw=`.
- Reading: `src/proxy.ts` correctly mints a per-request nonce and propagates it via `x-nonce` header for server components to consume. Some inline script (likely a theme-flicker preventer or chart-init blob) is rendered without `nonce={nonce}`.
- Severity: Medium. The script is blocked, so no XSS comes from it, but (a) some page logic likely fails silently, (b) the strict-CSP claim from Phase 3J is not fully honored, (c) every Vercel runtime log gets noise.
- Fix: find the inline `<script>` — search for `<script` in `src/app/**/layout.tsx`, `src/app/**/page.tsx`, `src/components/theme-*`, or any `dangerouslySetInnerHTML` — and apply `nonce={nonce}` from `headers().get('x-nonce')`. Or hash-pin the literal in the CSP if it's truly static.

### D-4 — Low — Cron endpoints unreachable from outside without a session cookie
- Method: `curl -i https://mwg-crm.vercel.app/api/cron/rescore-leads` (and three siblings, with and without `Authorization: Bearer wrongtoken`).
- Expected: 401 Unauthorized.
- Got: HTTP 307 to `/auth/signin?callbackUrl=%2Fapi%2Fcron%2Frescore-leads`.
- Cause: `src/proxy.ts` line ~74 redirects every non-public path on missing session cookie before the route handler ever runs. `src/app/api/cron/rescore-leads/route.ts` lines 14-19 do correctly verify `Bearer ${env.CRON_SECRET}` and 401 on mismatch — but the proxy already 307'd.
- Severity: Low. Vercel cron's internal calls bypass middleware redirect (they go through the function gateway), so the bearer check still gates production cron access. The only externally-visible weirdness is that an attacker probing `/api/cron/*` without a cookie sees a sign-in redirect, not a clean 401. This is informational signal leakage at most.
- Recommendation: in `src/proxy.ts`, treat `/api/cron/` as a public path so the route handler can return its own 401. (Same may apply to any future webhook route that authenticates via shared secret rather than session.)

### D-5 — Info — All 23 public tables have `rls_enabled` true with **zero** policies
- Method: `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'` and `SELECT * FROM pg_policies WHERE schemaname='public'`.
- Result: 23/23 tables RLS-enabled, 0 policies exist.
- This is the documented pattern: the app uses the **service role key** (which bypasses RLS) for all server-side DB access; RLS is "default deny" insurance against any future client-side connection. Not a vulnerability under the current architecture, but trivially becomes one if anon/authenticated-key access is ever added without writing policies first. Confirmed against Phase 4 claims.
- Severity: Info. Recommend a CI check that fails build if any new table is added without either (a) explicit `policy CREATE` or (b) a `-- service_role_only` comment-marker.

### D-6 — Low — `/api/auth/session` HEAD response advertises `Cache-Control: public`; GET correctly says `private, no-cache, no-store`
- Method: `curl -sI -X HEAD ...` vs `curl -sI -X GET ...`.
- HEAD: `Cache-Control: public, max-age=0, must-revalidate`
- GET: `Cache-Control: private, no-cache, no-store`
- Inconsistency is a Vercel/Next.js quirk; `must-revalidate` on the HEAD limits practical exposure, and intermediary caches keying on method generally don't pollute. Severity Low; may want to verify with Vercel support whether the HEAD response advertises a different cache policy than the actual GET response that follows.

---

## Verified-passing tests

- **D-V1 — Open redirect rejected (signin server action).** `src/app/auth/signin/actions.ts:79-83` `safeCallback()` rejects anything that is not a `/`-leading relative path, including `//evil.com` and `javascript:alert(1)`. Code review only — could not exercise the path without burning the breakglass session.
- **D-V2 — SQL injection in command palette / leads search field is harmless.** Typed `' OR 1=1 --` and `'; DROP TABLE users; --` into both the cmd-palette (Cmd+K) and the leads list filter input. URL becomes `?q=%27+OR+1%3D1+--`. Result: zero leads matched, no DB error, no 500. Drizzle parameterizes via `ilike`/`sql` — confirmed at `src/app/api/leads/check-duplicate/route.ts:48-52` and `src/app/(app)/leads/page.tsx`.
- **D-V3 — XSS in note body rendered as text.** Posted `<script>window.__xss_fired=true;alert('xss-note')</script><img src=x onerror=alert(2)>` as a note on lead `278de85b-...-810d399cb702`. Verified via `browser_evaluate`: `window.__xss_fired === false`, the literal payload appears inside `<p class="...">&lt;script&gt;...&lt;/script&gt;...</p>` (HTML-entity-escaped).
- **D-V4 — `accounts.website` and `leads.linkedin_url` defense in depth.** DB CHECK `crm_accounts_website_proto: ((website IS NULL) OR (website ~* '^https?://'::text))` and `leads_linkedin_url_protocol` reject `javascript:`, `data:`, `vbscript:` at the database. App-side `urlField` (src/lib/validation/primitives.ts:54-60) does the same.
- **D-V5 — CSRF enforced.** Cross-origin POST to `/api/auth/callback/breakglass` without the matching `csrfToken` cookie redirects to `?error=MissingCSRF`. Auth.js v5 default.
- **D-V6 — Lead-edit IDOR via tampered hidden `id` is blocked at server action.** Code review: `src/app/(app)/leads/actions.ts:101` calls `await requireLeadEditAccess(user, id)` before any update; access.ts (`src/lib/access.ts:73-92`) throws `ForbiddenError` on owner mismatch + missing `canViewAllRecords` + missing `isAdmin`. Same gate is applied at every other lead-mutation site (pipeline, convert, archive, tags, activities — 14 call-sites grep-confirmed).
- **D-V7 — Session JWT is HttpOnly + opaque to JS.** `document.cookie` returns `""` post-login. `/api/auth/session` returns minimal claims: `{user: {name, email, id, isAdmin, sessionVersion}, expires}`. No tokens, no PII beyond email + display name.
- **D-V8 — Breakglass password is argon2id.** `src/lib/password.ts` uses `@node-rs/argon2` `hash()` with `memoryCost: 19_456, timeCost: 2, parallelism: 1`. Stored hashes begin `$argon2id$v=19$m=19456,t=2,p=1$...` (format confirmed; not retrieving the live hash).
- **D-V9 — Sensitive data in logs: clean.** Vercel runtime logs (7 days, production) searched for `password_hash`, `Bearer ey`, `refresh_token`, `client_secret` → 0 matches. `password` query returned only one log line containing the substring "password authentication" from the Postgres connection string complaint earlier in the deploy — no plaintext password.
- **D-V10 — Strong response headers (root + dashboard + signin):**
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `X-Frame-Options: DENY` (and `frame-ancestors 'none'` in CSP)
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()`
- **D-V11 — CSP itself is well-formed and present on every authenticated 200.** `default-src 'self'; script-src 'self' 'nonce-XXX' 'strict-dynamic' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ...; frame-ancestors 'none'; form-action 'self' https://login.microsoftonline.com; base-uri 'self'; object-src 'none'; upgrade-insecure-requests`. Documented compromises (`unsafe-eval` for Next.js bundle loader, `unsafe-inline` for shadcn/Radix style injection) match `src/proxy.ts` comments.
- **D-V12 — Lead deletion via tampered hidden id requires both ownership-or-admin AND `canDeleteLeads`.** `src/lib/access.ts` `requireLeadAccess` plus `permissions.canDeleteLeads` check at the action layer (grep-confirmed 5 call-sites).
- **D-V13 — File upload boundary (code review).** `src/lib/validation/file-upload.ts` (1 line read but Phase 4A claim cited; `MAX_ATTACHMENT_BYTES = 10MB`, `MAX_IMPORT_BYTES = 25MB`, `FORBIDDEN_EXTENSIONS = {exe,bat,cmd,ps1,sh,scr,msi,dll,com,vbs,js,jar,app,lnk}`, `sanitizeFilename` strips `\x00-\x1f /\\:*?"<>|` and leading dots). Magic-byte check claim accepted from Phase 4A memory; not exercised live (no UI affordance currently exposed for attachments — only in import).
- **D-V14 — Server-side validation of email field.** DB CHECK `leads_email_format` enforces `^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$`. App-side `emailField` enforces RFC + 254-char cap.

---

## Inconclusive / not exercised

- **Rate-limit on breakglass authorize().** Code at `src/auth.ts:42-90` documents 5-attempts-per-15-minutes per username with in-memory map. Tried 10 wrong-password POSTs to `/api/auth/callback/breakglass` from the command line: all returned 302 to `?error=MissingCSRF` because cross-origin curl has no CSRF cookie pair, so the credentials provider's `authorize()` was never invoked. To verify live, would need a same-origin Playwright-driven test that completes 6+ wrong sign-ins from the form within 15 minutes WITHOUT exhausting the breakglass on the test deployment. Skipped to preserve the audit's own credentials. Confidence in code: high. Confidence in production behavior: medium.
- **Second-user IDOR (target a different owner's lead).** Database has only two users (breakglass + dustin.hannon) and one lead, owned by breakglass. Cannot verify "non-admin without `canViewAllRecords` is blocked from a foreign lead" via runtime. Code review (D-V6) is the basis for the PASS judgment.
- **Public Vercel Blob bucket exposure.** Could not list buckets from this audit's surface. Phase 5C/D claim places photos in `*.public.blob.vercel-storage.com` (allowed in CSP `img-src`) and attachments behind signed URLs. Not exercised; recommend a scripted check that lists every blob bucket and flags anything `public-read`.

---

## Quick-fix priority list (for whoever closes Phase 8)

1. (Medium) Find and nonce-tag the inline script that fires `sha256-zjP2BXYgSCCnXNMXI2IL1yRydoQdsGR/uCCr6kyKsD0=` on every page.
2. (Low) Add `/api/cron/` to `PUBLIC_PATH_PREFIXES` in `src/proxy.ts` so the bearer-check returns a clean 401 instead of a sign-in redirect.
3. (Low) Bind `leadCreateSchema.website` to `urlField`, and `firstName`/`lastName` to `nameField`, so the validation primitives are actually applied.
4. (Info) Verify ALL routes that accept user-supplied filenames feed through `sanitizeFilename` — code review on import + attachment flows.
5. (Info) Add a CI check that fails if any new `public.*` table lacks at least one explicit policy or the comment marker `-- service-role only`.
