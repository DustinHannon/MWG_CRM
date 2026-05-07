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
