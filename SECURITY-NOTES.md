# Security Review — Phase 2B (2026-05-07)

A focused tightening pass, not a rewrite. No restructuring auth, no new
auth providers, no MFA. Closing obvious holes only.

## 1. Dependency audit

`pnpm audit --prod` results:

### Bumped (HIGH / MODERATE)

| Package | From | To | Severity | Advisory |
|---|---|---|---|---|
| `next` | 16.1.6 | 16.2.5 | HIGH (DoS w/ Server Components) + 4× MODERATE (request smuggling, image cache exhaustion, postpone DoS, **CSRF bypass on Server Actions**) + 1× LOW (HMR CSRF) | GHSA-q4gf-8mx6-v5v3, GHSA-ggv3-7p47-pfv8, GHSA-3x4c-7xq6-9pq8, GHSA-h27x-g6w4-24gq, **GHSA-mq59-m269-xvcx** |
| `drizzle-orm` | 0.36.4 | 0.45.2 | HIGH (SQL injection via improperly escaped identifiers) | GHSA-gpj5-g38j-94v9 |
| `next-auth` | 5.0.0-beta.25 | 5.0.0-beta.30 | MODERATE (email misdelivery) | GHSA-5jpx-9hw9-2fx4 |

Build verified clean post-bump (`pnpm build`). Drizzle 0.36 → 0.45 is a 9-minor jump; smoke-tested with the whole app at build time, all type signatures still match.

The brief's mention of CVE-2025-66478 / 55183 / 55184 — those CVEs do not appear in the GitHub Advisory Database for our installed Next.js stream; the equivalent Next 16.x DoS / request-smuggling / CSRF advisories above are addressed by the 16.2.5 bump.

### Deferred

| Package | Severity | Why not bumped | Mitigations |
|---|---|---|---|
| `xlsx` | 2× HIGH (Prototype Pollution + ReDoS) | **No npm patch exists.** SheetJS only ships fixes via their CDN tarball or paid SheetJS Pro. | `import "server-only"` on `xlsx-import.ts` and `xlsx-template.ts`; only admins / users with `can_import` can upload files, capped at 10 MB; XLSX-only by extension. Tracked in ROADMAP for migration to a vetted alternative (e.g. `exceljs`) when bandwidth allows. |
| `postcss` (transitive via `next > postcss`) | MODERATE (XSS via unescaped `</style>`) | Build-only dependency; never executed at runtime against user input. Bumped Next.js bundles its own `postcss`; we cannot pin transitively without breaking the framework. | Will resolve when Next.js bumps its bundled postcss. |

Final state: **2 HIGH (xlsx, deferred) + 1 MODERATE (postcss, transitive)**, down from 11 vulnerabilities (4 HIGH + 6 MODERATE + 1 LOW).

## 2. Secret-leak scan

```bash
grep -rn "process.env" src/        # only src/lib/env.ts (zod-validated)
grep -rn "NEXT_PUBLIC_" src/       # zero matches
grep -rn "use client" src/         # 8 files, none read process.env
```

- All 13 `lib/*.ts` modules already had `import "server-only"` from Phase 1.
- Added `import "server-only"` to: `src/db/index.ts`, `src/auth.ts`, `src/lib/env.ts`, `src/lib/password.ts`. These are the modules that read database connection strings, AUTH_SECRET, or argon2 hashes.
- No `.env*` value has ever been committed (`git log --all -- .env*` → empty).
- `AUTH_SECRET` is set in Vercel env (never in repo). It is 32+ bytes of base64 — confirmed during Phase 1.

## 3. Defense in depth — server action / route handler audit

Every server action and route handler must check identity AND authorization at the handler. Middleware (`src/proxy.ts`) only does a lightweight cookie presence check — it is not the security boundary.

### Audit result

| File | Identity check | Permission check | Resource access check |
|---|---|---|---|
| `src/app/(app)/leads/actions.ts::createLeadAction` | `requireSession` | `canCreateLeads` | n/a (creating) |
| `src/app/(app)/leads/actions.ts::updateLeadAction` | `requireSession` | `requireLeadEditAccess` | **`requireLeadEditAccess` (added Phase 2B)** |
| `src/app/(app)/leads/actions.ts::deleteLeadAction` | `requireSession` | `canDeleteLeads` | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/import/actions.ts::importLeadsAction` | `requireSession` | `canImport` | n/a |
| `src/app/(app)/leads/[id]/activities/actions.ts::addNoteAction` | `requireSession` | (no extra perm — anyone with lead access) | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/[id]/activities/actions.ts::addCallAction` | `requireSession` | (same) | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/[id]/activities/actions.ts::addTaskAction` | `requireSession` | (same) | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/[id]/activities/actions.ts::deleteActivityAction` | `requireSession` | author-or-admin (in `deleteActivity`) | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/[id]/graph/actions.ts::sendEmailAction` | `requireSession` | `canSendEmail` | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/(app)/leads/[id]/graph/actions.ts::scheduleMeetingAction` | `requireSession` | (none — gated by Graph token) | **`requireLeadAccess` (added Phase 2B)** |
| `src/app/admin/users/[id]/actions.ts::updatePermission` | `requireAdmin` | n/a | n/a |
| `src/app/admin/users/[id]/actions.ts::updateAdminFlag` | `requireAdmin` | n/a | self-protect, breakglass-protect |
| `src/app/admin/users/[id]/actions.ts::updateActiveFlag` | `requireAdmin` | n/a | self-protect, breakglass-protect |
| `src/app/admin/users/[id]/actions.ts::forceReauth` | `requireAdmin` | n/a | n/a |
| `src/app/admin/users/[id]/actions.ts::rotateBreakglassPassword` | `requireAdmin` | n/a | n/a |
| `src/app/admin/data/actions.ts::deleteAllLeadsAction` | `requireAdmin` | type-to-confirm | n/a (admin total scope) |
| `src/app/admin/data/actions.ts::deleteAllActivitiesAction` | `requireAdmin` | type-to-confirm | n/a |
| `src/app/admin/data/actions.ts::deleteAllImportsAction` | `requireAdmin` | type-to-confirm | n/a |
| `src/app/auth/signin/actions.ts::signInBreakglassAction` | (entry point — issues session) | rate limited | safeCallback prevents open redirect |
| `src/app/api/auth/[...nextauth]/route.ts` | Auth.js handlers | Auth.js handles | n/a |
| `src/app/api/leads/export/route.ts::GET` | `requireSession` | `canExport` | scoped via `listLeads(user, ..., canViewAll)` |
| `src/app/api/leads/import-template/route.ts::GET` | `requireSession` | `canImport` | n/a |

### Closed in Phase 2B

The most material finding: **horizontal privilege escalation on lead mutations**. Before this pass, `updateLeadAction`, `deleteLeadAction`, the activity actions, and the Graph send actions only checked the actor's `canEditLeads` / `canSendEmail` permission flag — not whether the actor had access to the specific lead being mutated. A user with `canEditLeads` and **without** `canViewAllLeads` could submit a forged form with another user's lead UUID and edit / delete it.

Closed by adding `requireLeadAccess` and `requireLeadEditAccess` helpers in `src/lib/auth-helpers.ts` and wiring them into every handler that takes a `leadId` from form data. The new helpers:

- look up the lead's `owner_id`,
- pass admins through unconditionally,
- otherwise demand `owner_id === user.id` OR `permissions.can_view_all_leads = true`,
- throw `ForbiddenError` (caught by the action and returned as a structured error result, not a stack trace).

Also added `requireSelfOrAdmin(user, targetUserId)` for future user-profile mutations.

## 4. Cookie + session hardening

- `session: { strategy: "jwt", maxAge: 60 * 60 * 24 }` — 24h sliding window. Re-validated against DB on every request via the existing jwt callback (Phase 1), so deactivation propagates within one request roundtrip.
- Auth.js v5 sets `httpOnly: true`, `sameSite: "lax"`, and `secure: true` automatically when `AUTH_URL` is HTTPS. Verified by inspecting Auth.js cookie defaults — no override needed.
- `AUTH_SECRET` ≥ 32 chars: confirmed in Phase 1, set via `openssl rand -base64 32` in Vercel env. Not committed to repo.
- `users.session_version` bump invalidates JWTs (Phase 1 already wires this into the jwt callback comparison).

## 5. Security headers + Next.js config

`next.config.ts` now applies:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live https://*.vercel-scripts.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.public.blob.vercel-storage.com https://graph.microsoft.com; connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co https://*.vercel.app https://vercel.live wss://ws-us3.pusher.com; frame-ancestors 'none'; form-action 'self' https://login.microsoftonline.com; base-uri 'self'
```

Plus:

- `productionBrowserSourceMaps: false` — no source maps shipped to browsers.
- `poweredByHeader: false` — no `X-Powered-By: Next.js`.

CSP keeps `'unsafe-inline'` and `'unsafe-eval'` on scripts because Next.js + React ship inline bootstrap scripts and Vercel Live Toolbar requires eval. Tightening to a nonce-based strict CSP needs middleware coordination — tracked in `ROADMAP.md` for a future phase.

Verify post-deploy (the project doesn't have curl in this environment — run from any dev machine):

```bash
curl -sI https://mwg-crm.vercel.app | grep -iE '(strict-transport|x-frame|x-content|referrer|permissions|content-security|x-powered)'
```

## 6. Middleware matcher audit

`src/proxy.ts`:

- Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `robots.txt`, `sitemap.xml`, and any path with a file extension (assets).
- `PUBLIC_PATH_PREFIXES` whitelists `/auth/`, `/api/auth/`, `/_next/`, `/favicon`, `/robots.txt`, `/sitemap.xml`.
- The only `/api/*` routes are `/api/auth/[...nextauth]`, `/api/leads/export`, `/api/leads/import-template`. The latter two land on the protected branch (no public `/api` outside Auth.js).
- Both protected `/api` routes call `requireSession()` themselves, so the middleware-bypass scenarios noted in CVE-2025-29927 are mitigated by handler-level checks regardless of platform middleware behavior.

No changes needed.

## 7. Rate limiting (lightweight)

`src/auth.ts` Credentials provider now applies `checkBreakglassRateLimit(username)` before any DB / argon2 work:

- 5 attempts per username per 15-minute window.
- In-memory map, per process. Cold starts reset the counter — acceptable for breakglass which sees rare use.
- Returns `null` (so Auth.js issues an InvalidCredentials error) without leaking the rate-limit reason. Logged via `console.warn` for incident triage.

TODO in `ROADMAP.md`: upgrade to Upstash Redis for a durable sliding window once breakglass usage warrants.

## 8. What was NOT touched (per brief)

- Auth.js base configuration not altered beyond what's listed.
- No new auth providers.
- No multi-factor auth (Entra MFA already covers SSO; breakglass is intentionally simple — WebAuthn for breakglass is on `ROADMAP.md`).
- No ORM swap.
- No nonce-based CSP migration. The current CSP is the right starting point; tightening tracked separately.

## 9. Open items for ROADMAP.md

- Migrate off `xlsx` (HIGH, no npm patch).
- Strict nonce-based CSP (replace `'unsafe-inline'` on script-src).
- WebAuthn / passkey for breakglass instead of password.
- Upstash Redis for credential rate limiting (durable across cold starts).

## Phase 3J — Strict CSP with nonces (2026-05-07)

CSP migrated from static next.config.ts headers to per-request generation
in `src/proxy.ts`. Each request mints a fresh nonce, attaches it to the
request via `x-nonce`, and sets a `Content-Security-Policy` header on the
response using `'nonce-${nonce}' 'strict-dynamic'` for `script-src`.

**Pragmatic compromise:** `style-src 'unsafe-inline'` is retained because
shadcn/Radix and react-hook-form inject styles at runtime; nonce-tagging
every insertion would require deep framework integration. Inline scripts
are still blocked (script-src has no `'unsafe-inline'`).

**Why `'unsafe-eval'` is kept on script-src:** Next.js dev mode and
certain runtime libraries use eval. The strict-dynamic rule still gates
bundle loading via the trusted (nonced) script.

**Verification:** open every authenticated page with browser console; zero
CSP violations expected.

---

# Security Hardening — Phase 4A (2026-05-07)

A defense-in-depth pass on top of Phase 2B. No new auth providers, no MFA. The
goal: make every server boundary, every DB column, and every error path safer
by default so future phases inherit the safety budget instead of paying it.

## Dependency audit

`pnpm audit --prod` after Phase 4A:

| Severity | Package | Status |
|---|---|---|
| HIGH × 2 | `xlsx@0.18.5` | **Accepted, unchanged.** No npm patch exists. Mitigations: `server-only`, admin-only access, 10 MB attachment cap / 25 MB import cap, magic-byte validation, 10k-row import cap, chunked-transaction inserts, `failed_rows` cap (1000). All enforced at the server boundary in `src/lib/validation/`. |
| MODERATE | `postcss<8.5.10` | **Resolved.** `pnpm.overrides` pin: `"postcss@<8.5.10": "^8.5.14"`. Build verified green. |

## Validation primitives

`src/lib/validation/primitives.ts` — single source of Zod field validators:

- `nameField`        — letters / spaces / hyphens / apostrophes / periods, 1–100
- `emailField`       — RFC-ish, normalized lowercase, ≤ 254 chars (Postgres UNIQUE limit)
- `phoneField`       — parsed to E.164 via `libphonenumber-js`, falls back to literal
- `urlField`         — http / https only — rejects `javascript:`, `data:`, `file:`
- `currencyField`    — non-negative, ≤ 1B, max two decimal places
- `dateField`        — coerced, year ∈ [1900, 2100]
- `noteBody`         — 1–50,000 chars; HTML sanitization via `isomorphic-dompurify` is layered on top where rendering may include user-supplied HTML
- `tagName`          — letters / numbers / spaces / hyphens, 1–50
- `uuidField`        — strict UUID
- `versionField`     — coerced int ≥ 0 (optimistic concurrency stamp)
- `sanitizeFilename` — strips path separators, control chars, leading dots; cap 255

## File-upload validation

`src/lib/validation/file-upload.ts`:
- Magic-byte check via `file-type` — never trust client `Content-Type`.
- MIME allowlist: `pdf, png, jpeg, gif, webp, txt, csv, xlsx, docx, doc, xls`.
- Extension blocklist: `exe, bat, cmd, ps1, sh, scr, msi, dll, com, vbs, js, jar, app, lnk`.
- Size cap: 10 MB attachments, 25 MB imports.
- Octet-stream tolerance for `xlsx`/`docx` (legitimately mis-declared by old clients).

## CHECK constraints

Migration `phase4_check_constraints` adds DB-level seatbelts on every name /
email / url / numeric / date column across `leads`, `crm_accounts`, `contacts`,
`opportunities`, `tasks`, `activities`, `tags`, `notifications`. Existing data
scanned clean before applying. Garbage SQL inserts now reject at the DB even if
a future server action skips Zod.

## Optimistic concurrency

Migration `phase4_versioning` adds `version int NOT NULL DEFAULT 1` to every
mutable record. `concurrentUpdate()` enforces it. Append-only / safe-LWW
exceptions (audit_log, notifications, recent_views, lead_tags) are documented
in `ARCHITECTURE.md §7`.

## IDOR access gates

`src/lib/access.ts` — `requireAccountAccess`, `requireContactAccess`,
`requireOpportunityAccess`, `requireTaskAccess`, `requireSavedViewAccess`.
Phase 2's `requireLeadAccess` / `requireLeadEditAccess` (in
`src/lib/auth-helpers.ts`) cover lead actions. Every server action that takes
a record id calls one of these before reading or writing. Denials are
audit-logged at WARN with `access.denied.<entity>.<action>`.

## Database integrity

Migration `phase4_db_hardening`:
- RLS enabled on tables that were missing it: `notifications`, `recent_views`,
  `crm_accounts`, `contacts`, `opportunities`, `tasks`,
  `saved_search_subscriptions`, `tags`, `lead_tags`. (No policies: defense-in-depth
  pattern; `mwg_crm_app` role has BYPASSRLS.)
- `audit_log.actor_email_snapshot text` added; backfilled from current users.
  FK on `actor_id` is already `ON DELETE SET NULL` — emails now persist for
  forensic attribution after user delete.
- Covering indexes for every CASCADE FK + the SET-NULL FKs that participate
  in user-deactivation reassignment scans. ~24 indexes added.

Orphan scan (`scripts/orphan-scan.ts`) — zero rows across 16 parent/child
relationships at Phase 4A baseline.

## Structured logging

`src/lib/logger.ts` — JSON-line format, key redaction
(`password|token|secret|cookie|session|...`). `console.*` is forbidden in
committed code. Three documented exceptions (boot path; documented in
`ARCHITECTURE.md §8`).

`KnownError` hierarchy + `withErrorBoundary` (`src/lib/server-action.ts`)
ensure no DB strings, stack traces, or internal IDs leak in production
responses. Public messages are safe to render; the request id is the
support-ticket reference.

## Documented residual risks

| Risk | Mitigation | Tracking |
|---|---|---|
| `xlsx` HIGH × 2 (Prototype Pollution + ReDoS) | server-only, admin upload, 25 MB cap, magic bytes, 10k-row cap, chunked tx, capped failed rows | ROADMAP — switch to `exceljs` when bandwidth allows |
| Optimistic-concurrency UI banner not yet wired into every form | Backend rejects with `ConflictError`; UI fallback shows the generic error toast until per-form banners ship | Phase 4 follow-up — wire into lead detail and opportunity edit |
| Breakglass rate limit is in-memory (per-process) | Acceptable: breakglass usage is rare; cold starts reset the counter | If usage spikes, swap for Upstash Redis |

---

# Security Hardening — Phase 5G (2026-05-07)

## `xlsx` → `exceljs` migration (closed)

Both Phase 2B/4A HIGH advisories on `xlsx@0.18.5` (Prototype Pollution + ReDoS, no
upstream npm patch) are now **closed** by removing the dependency.

- `pnpm remove xlsx && pnpm add exceljs` — exceljs 4.4.0.
- Three call sites rewritten to ExcelJS API: `src/lib/xlsx-import.ts`
  (`importLeadsFromBuffer`, `buildErrorReport`, `buildLeadsExport`) and
  `src/lib/xlsx-template.ts` (`buildLeadImportTemplate`). Read path now uses
  `wb.xlsx.load(Uint8Array)`; write path uses `wb.xlsx.writeBuffer()`.
- Public surface: writer functions are now `async` (return `Promise<Uint8Array>`),
  matching the natively async ExcelJS API. The two route handlers
  (`/api/leads/export`, `/api/leads/import-template`) updated accordingly.
- `pnpm audit --prod` after migration: **No known vulnerabilities found.** Down
  from `2 HIGH (xlsx) + 0 MODERATE` after the Phase 4A postcss override.
- All other `xlsx`-era mitigations (server-only, admin-gated, 25 MB cap, magic
  bytes, 10k-row import cap, chunked-tx inserts, capped failed_rows) remain in
  place — they are good defense in depth regardless of parser.

## Database client / RLS verification

The codebase uses `postgres-js` directly via `src/db/index.ts` against the
Supabase Supavisor pooler with the privileged Postgres role (`POSTGRES_URL`).
There is no `@supabase/supabase-js` client (`createClient` / `createServerClient`)
anywhere in `src/`. Grep confirms zero matches.

Implication: server-side queries do **not** go through PostgREST + JWT and are
not subject to RLS. The `rls_enabled_no_policy` advisories on every public table
are intentional — RLS is enabled as a deny-default backstop for the anon key
(which we never expose / use), and our service-role-equivalent connection
bypasses RLS by design. No action required.

## Other Phase 5G items — status

- **JSDoc long tail** (every exported function in `src/lib/`, every server action
  / route handler) — **DEFERRED** to a follow-up. The high-traffic functions
  documented in Phase 4A still apply; the tail is a documentation backfill, not
  a security or correctness issue.


