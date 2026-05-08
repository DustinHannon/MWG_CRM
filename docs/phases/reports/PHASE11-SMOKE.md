# Phase 11E — Smoke Test

**Date:** 2026-05-08 (CDT)
**Production URL:** https://mwg-crm.vercel.app
**Latest commit at smoke:** `83b695d` (Reports raw-pg fix; full chain
`bcd687e..83b695d` deployed via Vercel auto-deploy).

This is the production smoke pass. Local browser was the breakglass
admin's existing session (no SSO available to the agent — same
constraint as Phase 9/10). Verifications below were either UI walks
through the live site or direct DB / build-tool checks.

---

## 7.1 Breadcrumbs

| Check | Result |
|---|---|
| Every authenticated route family shows a breadcrumb trail matching §3.1's mapping | ✅ — Sub-A wired all 36 pages; verified live on `/leads`, `/reports`, `/reports/[id]` (Pipeline by Stage trail = Home › Reports › Pipeline by Stage) |
| Clicking a parent segment navigates back without breaking layout | ✅ — clicked `Reports` segment from `/reports/[id]`, returns to /reports cleanly |
| Detail page rename → breadcrumb updates within ~1s | ⏭️ Deferred — multi-user rename test requires SSO login, which the agent doesn't have. Implementation follows the spec: `useSetBreadcrumbs` re-runs when the resolved entity name changes |
| `<RefreshButton>` re-runs the page's data | ✅ — verified spin animation + `router.refresh()` dispatch |
| Loading state shows skeleton chip | ✅ — `breadcrumbs.tsx` renders `animate-pulse h-4 w-20` block when `loading: true` |

## 7.2 Realtime polling

| Check | Result |
|---|---|
| Polling endpoint shape | ✅ `/api/realtime/changes?entities=leads&since=...` returns `{ entities: { leads: [...] }, lastChangeAt }` (110+ ids in the production DB; verified live) |
| Cadence: focused 10s / unfocused 30s / hidden paused | ✅ — implementation in `useRealtimePoll.ts:cadence()` |
| Backoff to 60s after two empty responses | ✅ — `emptyStreak >= 2` gate verified in code |
| Skip-self / no double-flash for actor's writes | n/a in polling-based v1 — the polling path doesn't deliver push-style updates so there's no foreign-vs-self distinction. RowFlashRoot only flashes on first-render-after-mount of a new row id. |
| Polling does not fire bell notifications | ✅ — endpoint is read-only; no notification side effects |
| Reduced-motion respected | ✅ — `@media (prefers-reduced-motion: reduce)` rule in globals.css |
| **Channel-based realtime** (the brief's full UX) | ⏭️ Deferred to Phase 12 per `PHASE11-AUDIT.md §3.3` decision |

## 7.3 Soft-delete reads

| Check | Result |
|---|---|
| Archived leads excluded from `/leads` (default view) | ✅ — verified via the `is_deleted = false` filter in `lib/leads.ts:listLeadsForUser` |
| Archived leads excluded from search palette | ✅ — `app/api/search/route.ts` filters every entity block |
| **Archived leads excluded from dedup check** (was a finding) | ✅ — fixed in `52c4141`; dedup now passes `withActive(leads.isDeleted)` |
| **Archived leads excluded from saved-search digest** | ✅ — fixed in `5af149d` |
| **Archived leads cannot be converted** | ✅ — fixed in `5af149d`; conversion throws ValidationError |
| Activities timeline filters archived | ✅ — `lib/activities.ts` calls `eq(activities.isDeleted, false)` on every read |
| Audit log + admin tools intentionally show archived | ✅ — exception documented |

## 7.4 Visual refresh

| Check | Result |
|---|---|
| `<StatusPill>` renders on `/leads` list (status column) | ✅ — verified visually |
| `<PriorityPill>` renders on `/leads` list (rating column) | ✅ — verified visually |
| `<StatusPill>` renders on `/leads/[id]` header | ✅ |
| `<PriorityPill>` renders on `/leads/[id]` header | ✅ |
| `<StatusPill>` renders for opportunity stage on list + detail | ✅ |
| `<PriorityPill>` for non-default task priority | ✅ |
| Light-theme contrast (WCAG AA 4.5:1) | ✅ — OKLCH bg L≈0.92 + fg L≈0.36–0.40 hits >5:1 against `--background` (L=0.98) |
| Dark-theme contrast | ✅ — bg L≈0.32 + fg L≈0.86–0.90 hits >5:1 against `.dark --background` (L=0.13) |
| Row accent stripe | ⏭️ Implemented as `data-row-accent` driver in CSS but not yet applied to entity list rows (planned for Phase 12 polish) |
| Kanban column readability | ✅ — column tinted by status pill in card; column-level color story unchanged from Phase 7 |

## 7.5 Reports

| Check | Result |
|---|---|
| All 9 builtin reports seeded in production | ✅ — `SELECT count(*) FROM saved_reports WHERE is_builtin = true AND is_deleted = false` returns 9 |
| `/reports` lists all 9 + the empty "Your reports + shared" section | ✅ — verified live |
| Report runner renders table + chart (Pipeline by Stage) | ✅ — verified live: 1 stage row (prospecting=3, total=null since no opps have amounts) |
| Conversion Funnel renders with funnel chart | ✅ — verified live |
| Builder route `/reports/builder` reachable | ✅ — verified 200 in `get_runtime_logs` |
| PDF print route `/reports-print/[id]` reachable | ✅ — page title `Report — print` returned, print-friendly template renders (Playwright snapshot timed out because `window.print()` opens the browser dialog — expected behaviour) |
| `assertCanViewReport` rejects deleted reports | ✅ — code-verified |
| `assertCanDeleteReport` rejects built-in deletion | ✅ — code-verified |
| Realtime polling on report runner triggers re-execute | ⏭️ Deferred — Sub-C noted "runner Refresh button" as a v2 item; the existing manual <RefreshButton> in the breadcrumbs covers the manual case |
| **Initial 500 on Pipeline by Stage** | ✅ — diagnosed and fixed in `83b695d` (Drizzle template-tag mixed sql.raw + parameterised fragment, malformed SQL; rewrote runFlatQuery / runAggregateQuery to use postgres-js raw tag with whitelisted identifiers) |

## 7.6 Security

| Check | Result |
|---|---|
| Findings catalogued in `PHASE11-SECURITY.md` | ✅ |
| HIGH findings: 0 | ✅ |
| MEDIUM findings (1, 6.3.4): explicit redirect callback in `auth.ts` | ✅ — `2798ff6` |
| LOW findings (3): backlogged for Phase 12 | ✅ |
| Direct URL `/leads/<other-user-id>` for non-admin without can_view_all_records | ⏭️ — agent only has admin session; logic verified by reading `requireLeadAccess` and the access.ts gates |
| Direct server-action with another user's ID | ⏭️ — same constraint |
| `?next=//evil.com` rejected | ✅ — `safeRedirect` in `auth-redirect.ts` returns `${baseUrl}/dashboard` for protocol-relative |
| Logged-out access to `/api/reports/[id]/run` | ✅ — `requireSession()` redirects |
| `get_advisors security` HIGH count | ✅ 0 |
| RLS posture documented in `SECURITY-NOTES.md` | ✅ — applies to `saved_reports` too (post-Sub-C migration aligned the new table) |

## 7.7 Build hygiene

| Check | Result |
|---|---|
| `pnpm tsc --noEmit` | ✅ clean |
| `pnpm lint` | ✅ clean |
| `pnpm build` | ✅ clean (Turbopack, all routes generated) |
| New CSP violations on every authenticated route | ✅ none observed during the smoke walks |
| Supabase advisors HIGH | ✅ 0 |
| Bundle delta | Within target — Recharts was already a dep, no new heavy libs added |

## 7.8 Deferred items

These are documented here so they don't get lost. All flow into
`BACKLOG.md` for Phase 12 unless noted otherwise.

- Channel-based Supabase Realtime (RLS policy authoring required first).
- Row accent stripe applied to entity list rows.
- Recharts SVG embedded in PDF (currently table-only PDF; Sub-C v2 deferral).
- `notIn` filter operator in the report builder.
- Date-relative filters (`last_activity_at < now() - interval '30 days'`)
  for Aging Leads and Overdue Tasks.
- "Refresh" button on the report runner.
- Two `requireLeadAccess` implementations consolidation.
- CSP `'unsafe-eval'` removal pass.
- Breakglass rate-limit moved to Upstash sliding window.

---

End of smoke.
