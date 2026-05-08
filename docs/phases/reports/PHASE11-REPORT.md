# Phase 11 — Final Report

**Date:** 2026-05-08 (CDT)
**Production:** https://mwg-crm.vercel.app — deployment
`dpl_…83b695d` and successors are live.
**Branch:** master, fast-forwarded.

---

## 1. Production status

- All 11 commits in this phase deployed via Vercel auto-deploy from
  master pushes.
- Every authenticated route returns 200 in the post-fix runtime logs.
- 9 built-in reports live in `saved_reports` (verified via SQL).

## 2. Audit summary (`PHASE11-AUDIT.md`)

The brief assumed a stack the repo doesn't have (Supabase JS client,
TanStack Query, Framer Motion). The audit:

- **Realtime:** zero tables in `supabase_realtime` publication; every
  table has RLS-enabled-no-policy; channel-based realtime would
  require RLS policy authoring. **Decision:** ship polling-based
  realtime in v1; channel-based is Phase 12.
- **Soft-delete reads:** 35 files touch the soft-deletable entities;
  three gaps surfaced and fixed (check-duplicate, saved-search-runner,
  conversion).
- **Security pre-audit:** surface scan flagged 1 MEDIUM (6.3.4 — fixed
  in 11D) and 3 LOW (deferred to Phase 12).

## 3. Schema migrations

- `phase11_saved_reports` — new `saved_reports` table with 4 partial
  indexes (`saved_reports_owner_active_idx`,
  `saved_reports_shared_active_idx`, `saved_reports_builtin_idx`,
  `saved_reports_deleted_by_id_idx`).
- `phase11_saved_reports_rls_align` — `ENABLE ROW LEVEL SECURITY` on
  `saved_reports` to align with the project's documented "RLS-enabled
  no-policy" posture.
- No publication adds (channel-based realtime deferred).

## 4. Sub-agent results

| Sub | Scope | Outcome | Report |
|---|---|---|---|
| A | Wire `<BreadcrumbsSetter>` + `<PagePoll>` across all authenticated pages | 36 pages wired in 4 commits; tc/lint/build clean | `PHASE11-SUBA-REPORT.md` |
| B | Soft-delete read audit + visual pill swap | 3 reads fixed (lib + 1 API route); pills swapped on /leads, /leads/[id], /opportunities, /opportunities/[id], /tasks list | (work folded into the lead's commits — no separate Sub-B report) |
| C | Reports feature end-to-end | 5 app routes, 4 API routes, 5 components, 2 lib helpers, 1 seeder, 9 builtin reports in production; 1 runtime bug found in smoke + fixed | `PHASE11-SUBC-REPORT.md` |

Wall clock for the parallel block: ~30 minutes from dispatch to both
sub-agents complete; smoke + fix added ~20 minutes.

## 5. Smoke test result

`PHASE11-SMOKE.md`. Every checklist item either ✅ or ⏭️ (deferred,
documented). The smoke discovered a 500 on the Pipeline by Stage
runner — Drizzle's `sql` template tag mishandling mixed `sql.raw` +
parameterised child fragments. Fixed by rewriting `executeReport` to
use the raw postgres-js tag (whitelisted identifiers, parameter
bindings).

## 6. Security report

`PHASE11-SECURITY.md`. Disposition:

- **HIGH:** 0
- **MEDIUM:** 1 (6.3.4 — fixed: explicit `redirect` callback in
  `auth.ts` delegating to `lib/auth-redirect.ts:safeRedirect`)
- **LOW:** 3 (6.1.6 breakglass rate-limit upgrade, 6.2.5 dual
  `requireLeadAccess` consolidation, 6.5.3 CSP `'unsafe-eval'` removal
  pass — all backlogged for Phase 12)
- **NEG:** the rest. All NEG findings explicitly documented so the
  next audit doesn't have to re-discover them.

## 7. Visual delta

The most visible change is the colored status / priority pills on the
high-traffic surfaces:

- `/leads` list — Status column and Rating column now render as colored
  pills (`<StatusPill>`, `<PriorityPill>`).
- `/leads/[id]` header — status + rating chips replaced with the new
  pills; do-not-contact uses the lost-status palette.
- `/opportunities` list — Stage column renders as `<StatusPill>`.
- `/opportunities/[id]` header — stage shown as a pill alongside amount
  and expected-close.
- `/tasks` list (task-list-client) — non-normal priorities render as
  `<PriorityPill>`; non-open status renders as `<StatusPill>`.

All pills carry OKLCH-paired bg+fg tokens defined in `globals.css`
under `:root` and `.dark`; contrast holds in both themes (computed at
~5:1 against the surface, above WCAG AA 4.5:1).

A visual diff (light + dark before/after of `/leads`,
`/opportunities`, and `/opportunities/pipeline`) was not captured in
this phase because the agent's authenticated session is admin-only and
non-deterministic for screenshot reproduction. Smoke walked the
surfaces live; the pill rendering is verified.

## 8. Reports inventory

The 9 built-in reports live in production with sample row counts (run
as the breakglass admin against the current dataset):

| Report | Entity | Rows returned (admin scope) |
|---|---|---|
| Pipeline by Stage | opportunity | 1 group row (prospecting=3, total nil) |
| Lead Source Performance | lead | 6 source groups |
| Activity Volume by User | activity | 1 user group |
| Conversion Funnel | lead | 5 status groups |
| Win/Loss Analysis | opportunity | 0 rows (no closed_won/closed_lost yet) |
| Account Penetration | opportunity | per-account count + sum |
| Aging Leads | lead | 100-row preview (all leads, sorted by last_activity) |
| Overdue Tasks | task | 0 rows (no open tasks) |
| Revenue Forecast | opportunity | 1 stage group (sum amounts nil) |

(Row counts depend on the current DB state at smoke time; the runner
is correct.)

## 9. Wall-clock

- 11A audit + 11B foundation: ~30 min serial.
- 11C parallel sub-agents (Sub-A, Sub-C): ~30 min parallel; Sub-B
  folded into the lead's work.
- 11D security audit + fix: ~10 min.
- 11E smoke + reports runtime fix: ~25 min (the runtime bug ate ~15).
- 11F final report: ~5 min.
- **Total:** ~100 min wall clock.

## 10. Manual steps still needed from user

None. Everything in this phase is live and self-serve.

The user may want to review `PHASE11-SECURITY.md` so they have an
explicit audit trail for the next compliance review.

## 11. Phase 12 backlog

This phase deliberately deferred several pieces. Each is documented in
either `PHASE11-AUDIT.md`, `PHASE11-SECURITY.md`, or
`PHASE11-SMOKE.md`. Consolidated list:

**Realtime (largest)**
- Channel-based Supabase Realtime via `@supabase/supabase-js` client.
  Requires RLS policy authoring per table to mirror the application
  layer's access checks; new RLS policies would let anon-key clients
  read row payloads via Realtime channels safely.
- "Refresh" button on the report runner (Sub-C v2 deferral).

**Visual / UX**
- Row accent stripe applied to entity list rows.
- Recharts SVG embedded in the PDF print template (Sub-C v2 deferral).
- Custom illustrations / loading states across all `archived` views.

**Reports**
- `notIn` filter operator (Sub-C v2 deferral).
- Date-relative filters (`last_activity_at < now() - interval '30 days'`)
  for Aging Leads / Overdue Tasks.
- Cross-entity reports (lead + opportunities + activities).
- Pivot tables.
- Email-delivered reports / scheduled report runs.

**Security**
- Consolidate the two `requireLeadAccess` implementations (6.2.5).
- CSP `'unsafe-eval'` removal pass (6.5.3).
- Breakglass rate-limit on Upstash sliding window (6.1.6).
- Move `pg_trgm` and `unaccent` extensions out of the `public` schema.

---

End of Phase 11.
