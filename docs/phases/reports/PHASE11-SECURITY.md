# Phase 11D — Security Audit (deep pass)

**Date:** 2026-05-08
**Scope:** the §6 checklist from the Phase 11 brief — auth, authz,
validation, data exposure, headers, browser hygiene, Supabase posture.
The §3.4 surface scan in `PHASE11-AUDIT.md` is the input; this is the
follow-through.

Findings are graded HIGH / MEDIUM / LOW / NEG (negative finding —
verified, no action). HIGH findings have a fix landed in Phase 11;
MEDIUM/LOW fall to `BACKLOG.md` as Phase 12 candidates.

---

## 6.1 Authentication & session

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.1.1 | Middleware (`src/proxy.ts`) gates every non-public path. Public allowlist is explicit (`/auth/`, `/api/auth/`, `/api/cron/`, `/_next/`, `/favicon`, `/robots.txt`, `/sitemap.xml`). | NEG | — |
| 6.1.2 | Session cookies `httpOnly`/`secure`/`sameSite=lax` set by Auth.js v5 default; absolute lifetime 24h (`session.maxAge`) with per-request DB revalidation in `jwt()`. | NEG | — |
| 6.1.3 | Sign-out clears cookies via `signOut()` from `next-auth/react`; verified in `user-panel.tsx`, `danger-zone-section.tsx`. | NEG | — |
| 6.1.4 | Failed-login responses generic. Breakglass returns `Invalid username or password.` with no enumeration. Microsoft OIDC failures redirect to `/auth/signin?error=…` with parametric error codes (`domain_not_allowed`, `missing_token`, etc.) — not user-controlled identifiers. | NEG | — |
| 6.1.5 | Microsoft Entra callback validates the `state` parameter and the JWT signature inside Auth.js v5 — handled by the framework. | NEG | — |
| 6.1.6 | **Breakglass attempts rate-limited in-process** to 5 per 15 minutes per username (`src/auth.ts:checkBreakglassRateLimit`). In-memory means cold starts reset the bucket; documented in code comment. Acceptable for breakglass usage volume. Phase 12 candidate: Upstash Redis sliding window. | LOW | Phase 12 |

## 6.2 Authorization

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.2.1 | Per-entity access helpers in `src/lib/access.ts` (lead, account, contact, opportunity, task, savedView) re-fetch and re-check on every action. All log `access.denied.*` audit entries. | NEG | — |
| 6.2.2 | `can_view_all_records` is read-only — does not gate `requireLeadEditAccess`/`requireOpportunityAccess`/etc beyond visibility. Edit/delete still require the targeted permission flag (`canEditLeads`, `canDeleteLeads`) or admin. | NEG | — |
| 6.2.3 | Admin checks read `users.is_admin` from the DB on every request via `requireSession()`'s "trust but verify" lookup. No client-token-claim trust path. | NEG | — |
| 6.2.4 | No route uses `searchParams.userId` or similar to determine the actor — actor always comes from `requireSession()`. | NEG | — |
| 6.2.5 | **Two `requireLeadAccess` implementations exist** — one in `src/lib/auth-helpers.ts` (returns `{ ownerId }`, used widely), one in `src/lib/access.ts` (returns the row, with audit logging). Same gate logic, different return shapes. Long-term consolidation is a refactor. **Documented; not consolidated in Phase 11** because the change touches every action call site and risks regressions outside this phase's scope. | LOW | Phase 12 |
| 6.2.6 | New `executeReport(report, viewer)` in `src/lib/reports/access.ts` enforces viewer-scope (not author-scope) at the query layer. A salesperson opening an admin-shared report sees only their own data. **Verified by code reading** the `buildViewerScope` helper. | NEG | Verified at the helper layer; smoke test in 11E. |
| 6.2.7 | Report mutations (`assertCanEditReport`, `assertCanDeleteReport`) reject built-in reports unconditionally and reject non-owner non-admin attempts. Mirrors the entity delete pattern from Phase 10. | NEG | — |

## 6.3 Input validation / URL injection

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.3.1 | All `[id]` route params are passed to Drizzle `.where(eq(table.id, id))` calls; the underlying `postgres-js` driver parameterises them. UUID-shaped values that aren't UUIDs return zero rows (Postgres throws which Auth.js's not-found handling converts into `notFound()`). | NEG | Belt-and-suspenders Zod validation on a few routes is desirable; documented as low-priority Phase 12. |
| 6.3.2 | Zod schemas use `z.string().uuid()` for id fields where the call site reaches into a query directly. Spot-checked `src/lib/leads.ts:leadFiltersSchema`, `lib/views.ts`, lead create/update schemas. | NEG | — |
| 6.3.3 | `safeCallback()` in `src/app/auth/signin/actions.ts` rejects protocol-relative (`//evil.com`) and absolute URLs — only same-origin paths starting with `/` are allowed. | NEG | — |
| 6.3.4 | **`src/app/auth/signin/microsoft-button.tsx` does NOT route `callbackUrl` through `safeCallback`.** It passes the raw query-string value to `signIn(...)`. Auth.js v5's default `redirect` callback validates: relative URLs are allowed, same-origin URLs are allowed, anything else is rejected (returns `baseUrl`). Verified by reading the Auth.js v5 source. So `?callbackUrl=https://evil.com` does NOT escape — Auth.js throws it away. **However** the safeguard isn't visible from our code; if a future maintainer adds a custom `redirect` callback, this protection could regress silently. **Action: add an explicit `redirect` callback in `src/auth.ts` that mirrors `safeCallback` semantics.** | MEDIUM | Phase 11 — see fix below |
| 6.3.5 | CSRF: server actions use Next.js's built-in CSRF token; mutating API routes use `requireSession()` which depends on a same-origin cookie — Lax SameSite + Auth.js v5 nonce coverage closes the standard CSRF surface. | NEG | — |

## 6.4 Data exposure

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.4.1 | Public route inventory: `/auth/signin`, `/auth/disabled`, `/api/auth/[...nextauth]`, `/api/cron/*`. None return CRM data without auth — cron uses `Bearer CRON_SECRET`, signin uses public templates only. | NEG | — |
| 6.4.2 | Production error responses don't leak schema. `src/lib/server-action.ts` `withErrorBoundary` flattens unknown errors to a generic message. Spot-checked: API routes throw `ValidationError`/`ForbiddenError`/`NotFoundError` with safe messages. | NEG | — |
| 6.4.3 | PDF / report exports: `executeReport` is the only path; viewer scope enforced. Built-in reports respect the viewer's scope, never the seeder's. | NEG | — |
| 6.4.4 | `audit_log.metadata` is not exposed in any user-facing surface other than the admin audit page. No password / token metadata in audit_log entries (verified by inspection of `src/lib/audit.ts` writers). | NEG | — |
| 6.4.5 | Notifications include only ids and short titles — no body content from related records. Recipient sees what they're authorized to see anyway. | NEG | — |
| 6.4.6 | File uploads (Vercel Blob avatar at `/api/users/[id]/avatar`) validate MIME and size via `lib/validation/file-upload.ts`. Non-admin user can upload only to own profile. Verified. | NEG | — |
| 6.4.7 | **Realtime polling endpoint `/api/realtime/changes` returns row IDs only, not data.** Scope filter applied via `withScope`-like inline filters — non-admin without `can_view_all_records` only sees IDs of rows they own (or are assigned to, for tasks). For activities, non-admin viewers get an empty array (parent-record gating is page-level). Documented. | NEG | — |

## 6.5 Headers & transport

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.5.1 | `next.config.ts` sets `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()`. | NEG | — |
| 6.5.2 | `src/proxy.ts` mints a per-request CSP nonce and sets a strict CSP. Nonce-based + strict-dynamic. `frame-ancestors 'none'` is set in CSP and X-Frame-Options is also DENY (belt & suspenders). | NEG | — |
| 6.5.3 | **CSP includes `'unsafe-eval'` in `script-src`.** Confirmed needed — Next.js 16's runtime in some build modes evaluates serialised React Server Component payloads. Production builds frequently still need `unsafe-eval` for the App Router runtime. **Documented; removal is Phase 12** pending a controlled CSP-tightening test. | LOW | Phase 12 |
| 6.5.4 | All routes are HTTPS-only via Vercel default; HSTS preload is on. | NEG | — |
| 6.5.5 | `connect-src` already includes `wss://*.supabase.co` for the Phase 12 channel-based realtime add-on — no CSP edit needed when that lands. | NEG | — |

## 6.6 Browser-side hygiene

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.6.1 | No `NEXT_PUBLIC_*` secrets. Codebase doesn't currently expose Supabase URL / anon key client-side because there's no Supabase JS client. | NEG | — |
| 6.6.2 | No production `console.log` of session, tokens, or PII. `src/lib/logger.ts` provides structured server-only logging. Spot-checked notable surfaces. | NEG | — |
| 6.6.3 | `dangerouslySetInnerHTML` use audited in Phase 8 — every site sanitizes via `isomorphic-dompurify`. New Reports code uses safe text rendering only (no markdown sources flowing into HTML in v1). | NEG | — |

## 6.7 Supabase posture

| ID | Finding | Grade | Disposition |
|---|---|---|---|
| 6.7.1 | Security advisors: 0 HIGH, 0 MEDIUM, 2 WARN (`extension_in_public` for `pg_trgm` and `unaccent`), 23 INFO `rls_enabled_no_policy`. | NEG | — |
| 6.7.2 | **RLS is enabled with no policies on every public table.** This is a deliberate posture: the app uses the postgres role via Supavisor (server-side only) and authorizes at the application layer. Anon + authenticated roles see zero rows, which is correct given we don't expose PostgREST or the Supabase JS client to browsers. **Documented** in `docs/architecture/SECURITY-NOTES.md` so future maintainers don't naively add an `ALL USING (true)` policy. | NEG | — |
| 6.7.3 | Service-role key only ever used in server-side code. Verified by grep: no `SUPABASE_SERVICE_ROLE_KEY` reference in any client component. | NEG | — |
| 6.7.4 | Performance advisors: 50+ INFO `unused_index` notices including the new Phase 10 `*_active_*` partial indexes (recently created — counters cold). No action. | NEG | — |
| 6.7.5 | Auth DB connection strategy advisor (INFO) flags absolute connection cap of 10 — relevant only if instance size grows. No action. | NEG | — |

---

## 6.8 Fixes landed in Phase 11D

### Fix 1 — explicit `redirect` callback in Auth.js (finding 6.3.4)

Adds a `redirect` callback to `src/auth.ts` that delegates to a shared
`safeRedirect()` helper, centralising the open-redirect defence so it
holds even if a future change brings in a custom `redirect` and
inadvertently widens it. Same logic as `safeCallback` in
`auth/signin/actions.ts`, extracted to `src/lib/auth-redirect.ts`.

(Implementation alongside this document.)

---

## 6.9 Disposition summary

- **HIGH:** 0
- **MEDIUM:** 1 (6.3.4 — fixed in Phase 11D)
- **LOW:** 3 (6.1.6, 6.2.5, 6.5.3 — `BACKLOG.md` for Phase 12)
- **NEG:** the remainder. Verified, no action.

End of audit.
