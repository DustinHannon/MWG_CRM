# Phase 11A — Audit

**Date:** 2026-05-08
**Branch:** master
**Project:** mwg-crm (Supabase id `ylsstqcvhkggjbxrgezg`)
**Scope:** breadcrumb readiness · realtime infrastructure · soft-delete
read coverage · security pre-audit (the surface scan; depth in 11D).

---

## 1. Codebase reality vs. the Phase 11 brief

The brief assumes a stack the repo does not have. Confirming what's
actually in `package.json`:

| Brief | Reality |
|---|---|
| Supabase JS client | **not installed** — Drizzle + `postgres` is the only DB layer |
| TanStack Query | **not installed** |
| Framer Motion | **not installed** |
| Recharts | installed (`^3.8.1`) — usable for the Reports charts |
| `@radix-ui/react-alert-dialog`, `react-dialog`, `react-popover`, `react-tooltip` | installed |
| Sonner | installed (already powers the existing `<UndoToast>`) |

**Implication:** the brief's Realtime architecture (`supabase.channel(...).on('postgres_changes', ...)`)
cannot be wired without first adding `@supabase/supabase-js` and
authoring RLS policies that mirror the application-layer access checks.
Both are non-trivial and gated by security work. Decision: ship a
**polling-based realtime** for v1; channel-based realtime is Phase 12.
See `PLAN-PHASE11.md` for the full reasoning.

---

## 2. Breadcrumb route inventory

Every authenticated route family that needs a trail. Routes already
exist; column three is the natural breadcrumb path Sub-A wires in §11C.

| Route | Page file | Breadcrumb |
|---|---|---|
| `/dashboard` | `(app)/dashboard/page.tsx` | Dashboard |
| `/leads` | `(app)/leads/page.tsx` | Leads |
| `/leads/new` | `(app)/leads/new/page.tsx` | Leads › New |
| `/leads/import` | `(app)/leads/import/page.tsx` | Leads › Import |
| `/leads/pipeline` | `(app)/leads/pipeline/page.tsx` | Leads › Pipeline |
| `/leads/archived` | `(app)/leads/archived/page.tsx` | Leads › Archived |
| `/leads/[id]` | `(app)/leads/[id]/page.tsx` | Leads › *Lead Name* |
| `/leads/[id]/edit` | `(app)/leads/[id]/edit/page.tsx` | Leads › *Lead Name* › Edit |
| `/accounts` | `(app)/accounts/page.tsx` | Accounts |
| `/accounts/new` | `(app)/accounts/new/page.tsx` | Accounts › New |
| `/accounts/[id]` | `(app)/accounts/[id]/page.tsx` | Accounts › *Account Name* |
| `/accounts/archived` | `(app)/accounts/archived/page.tsx` | Accounts › Archived |
| `/contacts` | `(app)/contacts/page.tsx` | Contacts |
| `/contacts/new` | `(app)/contacts/new/page.tsx` | Contacts › New |
| `/contacts/[id]` | `(app)/contacts/[id]/page.tsx` | Contacts › *Contact Name* |
| `/contacts/archived` | `(app)/contacts/archived/page.tsx` | Contacts › Archived |
| `/opportunities` | `(app)/opportunities/page.tsx` | Opportunities |
| `/opportunities/new` | `(app)/opportunities/new/page.tsx` | Opportunities › New |
| `/opportunities/pipeline` | `(app)/opportunities/pipeline/page.tsx` | Opportunities › Pipeline |
| `/opportunities/[id]` | `(app)/opportunities/[id]/page.tsx` | Opportunities › *Name* |
| `/opportunities/archived` | `(app)/opportunities/archived/page.tsx` | Opportunities › Archived |
| `/tasks` | `(app)/tasks/page.tsx` | Tasks |
| `/tasks/archived` | `(app)/tasks/archived/page.tsx` | Tasks › Archived |
| `/notifications` | `(app)/notifications/page.tsx` | Notifications |
| `/users/[id]` | `(app)/users/[id]/page.tsx` | Users › *User Name* |
| `/settings` | `(app)/settings/page.tsx` | Settings |
| `/admin` | `admin/page.tsx` | Admin |
| `/admin/users` | `admin/users/page.tsx` | Admin › Users |
| `/admin/users/[id]` | `admin/users/[id]/page.tsx` | Admin › Users › *User* |
| `/admin/audit` | `admin/audit/page.tsx` | Admin › Audit Log |
| `/admin/data` | `admin/data/page.tsx` | Admin › Data |
| `/admin/scoring` | `admin/scoring/page.tsx` | Admin › Lead Scoring |
| `/admin/tags` | `admin/tags/page.tsx` | Admin › Tags |
| `/admin/settings` | `admin/settings/page.tsx` | Admin › Settings |
| `/reports` (new in 11C) | `(app)/reports/page.tsx` | Reports |
| `/reports/builder` (new) | `(app)/reports/builder/page.tsx` | Reports › New Report |
| `/reports/[id]` (new) | `(app)/reports/[id]/page.tsx` | Reports › *Report Name* |

Out of scope (no chrome — print page outside `(app)`):
- `/leads/print/[id]`
- `/auth/*`

---

## 3. Realtime infrastructure check

### 3.1 Replication publication

```sql
SELECT t.tablename,
       CASE WHEN p.tablename IS NOT NULL THEN 'YES' ELSE 'NO' END
       AS in_supabase_realtime
FROM pg_tables t
LEFT JOIN pg_publication_tables p
  ON p.tablename = t.tablename AND p.schemaname = t.schemaname
  AND p.pubname = 'supabase_realtime'
WHERE t.schemaname = 'public'
  AND t.tablename IN ('leads','crm_accounts','contacts','opportunities',
                      'tasks','activities','notifications','audit_log',
                      'users','permissions');
```

| Table | In `supabase_realtime` |
|---|---|
| activities | NO |
| audit_log | NO |
| contacts | NO |
| crm_accounts | NO |
| leads | NO |
| notifications | NO |
| opportunities | NO |
| permissions | NO |
| tasks | NO |
| users | NO |

**Zero** tables are in the publication. The brief's `ALTER PUBLICATION
ADD TABLE` step would be needed for every table.

### 3.2 RLS posture (advisor confirmation)

Every public table has **RLS enabled with no policies**:

```
rls_enabled_no_policy: accounts, activities, attachments, audit_log,
contacts, crm_accounts, import_jobs, lead_scoring_rules,
lead_scoring_settings, lead_tags, leads, notifications, opportunities,
permissions, recent_views, saved_search_subscriptions, saved_views,
sessions, tags, tasks, user_preferences, users, verification_tokens
```

Background: the app uses the `postgres` role via Supavisor (server-side
only), which bypasses RLS by default for the table owner. Anon and
authenticated roles get **zero rows** without explicit policies. This
keeps the data secure against anon-key misuse but **breaks Supabase
Realtime** entirely — Realtime authenticates as the user's role
(authenticated for a JWT, anon otherwise) and is RLS-bound.

### 3.3 Decision

Channel-based realtime is **deferred to Phase 12**. Phase 11 ships:

- A focused-tab polling loop (`useRealtimePoll(entities, since)`).
- A new endpoint `/api/realtime/changes` returning a small JSON
  `{ entities: { leads: ['<id>', ...], ... }, lastChangeAt: <iso> }`
  for changes the viewer is allowed to see (already filtered through
  the same access scope used by list pages).
- Client triggers `router.refresh()` when the response carries new ids.
- DOM-level row-flash detected in a hydrated `<RowFlash>` wrapper that
  diff-checks `data-row-id` against the previous render.

Polling cadence:
- Visible focused tab: 10s.
- Visible unfocused tab (same window): 30s.
- Hidden tab (`document.visibilityState === 'hidden'`): paused.
- Backoff to 60s after two consecutive empty responses.

The `lastChangeAt` field doubles as the "polling fallback every 60s"
guarantee in the brief.

---

## 4. Soft-delete read coverage

### 4.1 Helper status

`src/lib/db/active.ts` already exposes `notDeletedX()` per entity. The
codebase calls these inconsistently:

```
git grep -nE "isDeleted|notDeleted|is_deleted" src/
```

Returns 35 files. Spot checks:

| File | Soft-delete filter present? |
|---|---|
| `lib/leads.ts` | ✓ `eq(leads.isDeleted, false)` in list, getById, dedup |
| `lib/accounts.ts`, `lib/contacts.ts`, `lib/opportunities.ts`, `lib/tasks.ts` | ✓ |
| `lib/activities.ts` | ✓ on every read |
| `app/api/search/route.ts` | ✓ all six entity blocks have `is_deleted = false` |
| **`app/api/leads/check-duplicate/route.ts`** | **✗ MISSING** — archived leads will appear in dedup checks |
| `app/(app)/dashboard/page.tsx` | needs verification — see §4.3 |
| `lib/saved-search-runner.ts` | needs verification — see §4.3 |
| `lib/scoring/engine.ts` | ✓ |
| `lib/conversion.ts` | unknown — flag for §11C-Sub-B |
| `lib/import/preview.ts`, `lib/import/commit.ts` | imports operate on the row being imported, before any soft-delete state — exception OK |

### 4.2 Confirmed gaps to fix in 11C-Sub-B

1. **`app/api/leads/check-duplicate/route.ts`** — add `eq(leads.isDeleted, false)`
   to the `where` clause. Archived leads should not appear as
   "duplicates" against new leads.
2. The whole-codebase replacement: `eq(<table>.isDeleted, false)` → call
   the existing `notDeletedX()` helpers. Inconsistency makes future
   audits harder.
3. New helper `withActive(query, table)` — small wrapper that returns
   the query with the right not-deleted condition appended, so callers
   stop importing per-table fragments. Sub-B replaces sites
   incrementally.

### 4.3 Files to spot-check during 11C-Sub-B

- `app/(app)/dashboard/page.tsx` — KPI tiles must exclude archived rows.
- `lib/saved-search-runner.ts` — the saved-search digest cron should
  skip archived rows.
- `lib/conversion.ts` — converting a lead reads source data; verify it
  rejects already-archived leads.
- `app/(app)/leads/[id]/_components/lead-detail-delete.tsx` — already
  Phase 10 territory; no further work.
- Any place that queries `activities` outside `lib/activities.ts`
  (none currently — every activity read goes through that lib).

### 4.4 Files that intentionally see archived rows

These must NOT have the filter added; document with a code comment:

- `*/archived/page.tsx` (5 of them: leads, accounts, contacts,
  opportunities, tasks).
- `app/admin/audit/page.tsx` — audit log shows the activity history,
  including events on now-archived rows.
- `app/api/cron/purge-archived/route.ts` — explicitly works on archived
  rows.

---

## 5. Security pre-audit — surface scan

Deep pass is §11D. This section captures findings cheap to surface now.

### 5.1 Auth middleware coverage

`src/proxy.ts` (Next.js 16 proxy, the renamed middleware):

- Public path prefixes: `/auth/`, `/api/auth/`, `/api/cron/`, `/_next/`,
  `/favicon`, `/robots.txt`, `/sitemap.xml`.
- Everything else requires a session cookie. ✓
- Mints a per-request CSP nonce, attaches `x-nonce`, sets
  `Content-Security-Policy` header.
- Cron endpoints use `Bearer CRON_SECRET` for their own auth (skip
  cookie redirect to avoid 307 → /auth/signin instead of clean 401).
- `next.config.ts` adds the static security headers (HSTS, X-Frame,
  X-Content-Type, Referrer-Policy, Permissions-Policy). ✓
- **CSP includes `'unsafe-eval'`** — flagged for §11D investigation.
  May be required for some old Next.js dev assertion; production builds
  often drop it. Documented in `SECURITY-NOTES.md`.

### 5.2 Server-action ID-trust

`src/lib/access.ts` exposes `requireLeadAccess`, `requireAccountAccess`,
`requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess`,
`requireSavedViewAccess`. All re-fetch and re-check ownership; all
emit `access.denied.*` audit events on miss.

There is a **second `requireLeadAccess` in `src/lib/auth-helpers.ts`** with
slightly different semantics (returns ownerId rather than the row).
**Finding:** consolidate. The two co-existing is a maintenance risk —
audit log entries split across two paths if used inconsistently.
Tracked in §11D.

### 5.3 URL injection vectors

- `safeCallback()` in `src/app/auth/signin/actions.ts` rejects
  protocol-relative (`//evil.com`) and absolute URLs — only same-origin
  paths starting with `/` allowed. ✓
- `src/app/auth/signin/microsoft-button.tsx` invokes `signIn()` with
  `redirectTo: callbackUrl ?? "/dashboard"` — **does NOT route through
  `safeCallback`**. Auth.js v5 itself does some validation on
  `redirectTo`; needs §11D verification that an `?callbackUrl=//evil.com`
  query string can't escape.
- All `[id]` route params: §11D will run a UUID-validation sweep.
- All Zod schemas: most use `z.string().uuid()` for id fields. Spot
  check during §11D.

### 5.4 Header policy

From `next.config.ts`:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

CSP comes from the proxy:

```
default-src 'self'
script-src 'self' 'nonce-<nonce>' 'strict-dynamic' 'unsafe-eval'
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
font-src 'self' https://fonts.gstatic.com data:
img-src 'self' data: blob: https://*.public.blob.vercel-storage.com https://graph.microsoft.com
connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co
frame-ancestors 'none'
form-action 'self' https://login.microsoftonline.com
base-uri 'self'
object-src 'none'
upgrade-insecure-requests
```

Findings:
1. ✓ All recommended headers present.
2. ⚠️ `'unsafe-eval'` in script-src — investigate whether it's still
   needed; if not, remove.
3. ✓ `connect-src` already permits `wss://*.supabase.co` for the
   future Supabase Realtime channels (Phase 12).
4. ✓ `frame-ancestors 'none'` covers clickjacking even without
   `X-Frame-Options` (which is also set).

### 5.5 Supabase advisors

**Security advisors (HIGH/MEDIUM):** none.
**Security advisors (WARN):**
- `extension_in_public` — `pg_trgm` and `unaccent` are installed in the
  `public` schema. Documented but low risk for Phase 11.

**Security advisors (INFO):** 22 × `rls_enabled_no_policy` (see §3.2).
This is a deliberate posture (app-layer authz, no anon access) but
should be explicitly documented in `SECURITY-NOTES.md` so future
maintainers don't "fix" it with naïve all-rows policies.

**Performance advisors (INFO):** 50+ unused-index notices, including
the new Phase 10 `*_active_*` partial indexes (recently created — usage
counters are still cold). No action.

### 5.6 Error-message leakage

Spot scan: `src/lib/errors.ts` exports `ValidationError`, `NotFoundError`,
`ForbiddenError`. `src/lib/server-action.ts` provides `withErrorBoundary`
that converts unknown errors into a generic toast-friendly response.
**Sub-B/C should not throw raw `Error("user `${email}` not found")`** in
the new Reports code. Lint check during §11D.

### 5.7 Browser-side hygiene

- No `NEXT_PUBLIC_*` secrets. The Supabase URL and anon key are not
  currently exposed (they're not used anywhere client-side because
  there's no Supabase JS client).
- `dangerouslySetInnerHTML` audited during Phase 8; flagged sites use
  `isomorphic-dompurify` already.
- Phase 11 should preserve this — Reports HTML output (e.g., a saved
  description rendered with markdown) should also flow through
  DOMPurify.

---

## 6. Disposition

| Finding | Action | Where |
|---|---|---|
| Realtime publication empty | Defer channel-based realtime to Phase 12; ship polling for v1 | §11B + §11C-Sub-A |
| RLS enabled, no policies | Document deliberate posture in `SECURITY-NOTES.md` | §11D |
| `check-duplicate` route missing `is_deleted=false` | Add filter | §11C-Sub-B |
| Two `requireLeadAccess` functions | Consolidate or document divergence | §11D |
| Microsoft sign-in `callbackUrl` not run through `safeCallback` | Verify Auth.js v5 default validation; harden if needed | §11D |
| CSP `'unsafe-eval'` | Investigate, remove if unused | §11D |
| `pg_trgm`/`unaccent` in public schema | Backlog (low) | Phase 12 |
| Reports access scope = viewer's | Implemented as `executeReport(report, viewer)` in §11B | §11B + §11C-Sub-C |

End of audit.
