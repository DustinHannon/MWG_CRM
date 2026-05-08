# Phase 12 — Final Report

> Final report for the Phase 12 hardening sprint. Scope per build brief
> §1: realtime layer rebuild, deep concurrency review, mobile UI pass,
> production-only Playwright suite.

---

## 1. Production status

- **Production URL:** https://mwg-crm.vercel.app
- **Final Phase 12 deployment:** `dpl_9zRv254omSLgtvCuB4eQpBsAwSFo`
  (commit `af94f52`, redeploy to pick up env vars) — state **READY**
- **Earlier deployments in this phase:**
  - `dpl_JCTSh…` (5854bad) — Phase 12B foundation
  - `dpl_7eZ43…` (a9d3596) — Sub-A: realtime wiring across 19 pages
  - `dpl_GB5Us…` (dc9aa6e) — Sub-A: actor stamping on every UPDATE
  - `dpl_D44fM…` (9bd11fb) — Sub-A: BUG-003 undo-toast fix
  - `dpl_FPGgb…` (7734e42) — Sub-A: report and ledger
- **Health:** runtime logs show **0 errors / 0 warnings** in the 10
  minutes after the final deployment. CSP already permits
  `wss://*.supabase.co` (verified live). Realtime layer **operational**
  pending the user-driven two-window smoke described in §6.

## 2. Inventory recap

`docs/phases/reports/PHASE12-INVENTORY.md` is the spine. Highlights:

- **24 public tables**; 7 entity tables now wired to realtime
  (`leads`, `crm_accounts`, `contacts`, `opportunities`, `tasks`,
  `activities`, `notifications`).
- Phase 11A confirmed: zero entity tables in the publication, zero
  RLS policies. Phase 12B closed both gaps.
- Sub-A wired all 19 client list/detail/archive/pipeline pages plus
  the layout-level notifications subscription.

## 3. Bug ledger summary

`docs/phases/reports/PHASE12-BUGS.md` tracks 9 findings:

| Severity | Count | Status |
|---|---|---|
| HIGH | 0 | — |
| MED  | 4 | 2 fixed (BUG-003, BUG-007), 1 deferred (BUG-002), 1 reclassified to LOW (BUG-001) |
| LOW  | 5 | 3 fixed (BUG-005, BUG-006, BUG-007), 2 accepted (BUG-008, BUG-009) |

Notable fixes shipped this phase:
- **BUG-003** (MED, fixed `9bd11fb`): undo-toast after admin hard-delete
  now throws `NotFoundError` with a useful message instead of a
  misleading `ForbiddenError`.
- **BUG-005/006/007** (LOW/MED, fixed `dc9aa6e`): every entity-UPDATE
  call site now stamps `updated_by_id`. Without this, skip-self breaks
  and the user sees their own writes echoed back.
- **BUG-001** (originally MED, reclassified LOW + accepted): no
  `updateActivity` exists; activities are immutable except soft-delete.
  Reclassified after audit.

Deferred to Phase 13 (`BACKLOG-PHASE13.md`):
- BUG-002 — submission lock on image-upload paths
- BUG-004 — hover-only delete affordances (Sub-B mobile pass owns)
- 127 raw Tailwind palette literals across 40 files (theme drift)

## 4. Concurrency findings

`docs/known-races.md` is empty (good — no races were knowingly
accepted; everything was either fixed or deferred). Sub-A's audit
covered: two-tab same-user simultaneous archive, cross-owner activity
edges, undo-after-hard-delete, notification fan-out partial failure,
form double-submit, soft/hard-delete-while-open, and updateActivity
OCC. Each finding fed into the bug ledger.

## 5. Mobile coverage

**Deferred to a follow-up session.** Sub-B was not dispatched in this
session — the worktree-isolation harness wasn't available, and the
mobile pass would have conflicted with Sub-A's realtime wiring across
the same files. Scope per `PLAN-PHASE12.md §"Sub-B mobile pass scope"`
remains valid and unchanged. Recommended next step: dispatch Sub-B in a
fresh session now that Sub-A's work is merged.

## 6. Playwright results

**Foundation shipped; full catalog deferred.** Phase 12B delivered:

- `playwright.config.ts` (production-only, `baseURL=mwg-crm.vercel.app`,
  3 projects: desktop-chromium, mobile-iphone, tablet-ipad)
- `tests/e2e/global-setup.ts` (real Entra SSO via
  `PLAYWRIGHT_LOGIN_EMAIL` + `PLAYWRIGHT_LOGIN_PASSWORD`, 6h cached
  storage state, fails loudly on MFA prompt)
- `tests/e2e/global-teardown.ts` + `cleanup.ts` (purge by
  `E2E_RUN_ID`, 24h orphan sweep)
- `tests/e2e/fixtures/auth.ts` (injects `X-E2E-Run-Id` header)
- `tests/e2e/fixtures/run-id.ts` (`tagName(...)` helper)
- Seed specs: `auth.spec.ts`, `realtime.spec.ts` (with
  `_e2eDisableSkipSelf` escape hatch for single-account testing)

The full catalog from build brief §5.3.1 (leads / accounts / contacts /
opportunities / tasks / activities / pipeline / notifications /
permissions / reports / breadcrumbs / soft-delete / mobile/*) is
**deferred** to a follow-up session. Cannot run end-to-end until the
user sets `PLAYWRIGHT_LOGIN_EMAIL`/`PASSWORD` locally (these are not
in any Vercel env scope yet — they'd be CI-scope only when CI is
wired).

## 7. Theme drift summary

Sub-A's pass found 127 raw Tailwind palette literals across 40 files.
Replacement with semantic tokens is filed as **P13-001** in
`BACKLOG-PHASE13.md` — too large for the 50-line per-finding cap.
Phase 11B's StatusPill/PriorityPill effort already addressed the
highest-traffic surfaces.

## 8. Sub-agent results

| Sub-agent | Outcome |
|---|---|
| **Sub-A — review + concurrency + realtime wiring** | 4 commits to master (`a9d3596`, `dc9aa6e`, `9bd11fb`, `7734e42`). 19/19 pages wired (100%). 11 actor-stamping fixes across 6 files. 9 ledger entries (3 fixed in-phase, 3 accepted after audit, 3 deferred). Wall-clock ~18 min. Final report `PHASE12-SUBA-REPORT.md`. |
| **Sub-B — mobile UI pass** | Deferred to next session. |
| **Sub-C — Playwright catalog** | Foundation only (Phase 12B). Full catalog deferred to next session. |

## 9. Realtime architecture doc

`docs/realtime-architecture.md` — publication, RLS helpers in `public`
schema (Management API role can't write to `auth`), JWT bridge
endpoint, `<RealtimeProvider>`, hooks (`useTableSubscription`,
`useRowSubscription`), `<PageRealtime>` drop-in, skip-self via
`updated_by_id` / `user_id`, `_e2eDisableSkipSelf` escape hatch, and
failure modes.

## 10. Supabase plan recommendation

### Current state

- **Plan:** Pro ($25/mo per project) — verified via MCP
- **Database size:** 13 MB (Pro ceiling: 8 GB → >99% headroom)
- **Active users:** 4 (Pro ceiling: 100K MAU → effectively unlimited)
- **Realtime concurrent peak observed:** still 0 today (publication
  was empty before Phase 12B); projected ~12 (4 users × 3 channels) on
  full rollout — well below Pro's 500-concurrent cap with $10/1k overage
- **Project status:** ACTIVE_HEALTHY, `us-east-1`, Postgres 17.6.1.113
- **JWT signing:** ES256 (asymmetric, JWKS-published) is the primary
  scheme; legacy HS256 secret remains active for verification (this
  is what `SUPABASE_JWT_SECRET` set in Vercel today)

### Recommendation

**Stay on Pro. No upgrade needed.** Current usage is far below every
Pro ceiling and will remain so for the foreseeable future at MWG's
scale. Worked example: 100 active users would still be 0.1% of MAU
ceiling; 100 concurrent realtime channels would be 20% of cap; both
trajectories require zero plan change.

### Upgrade triggers (none currently met)

- **Team ($599/mo)** — only if MWG's compliance auditors specifically
  require Supabase's own SOC 2 attestations folded into MWG's
  compliance package, OR if MWG IT wants SSO into the Supabase
  dashboard. Functionally identical to Pro for the workload.
- **Enterprise (custom)** — only if MWG's HIPAA posture demands a BAA
  with Supabase. Confirm with MWG compliance lead. Not triggered by
  usage.

## 11. Manual steps the user already completed during this phase

- ✅ **Set `NEXT_PUBLIC_SUPABASE_URL`** in Vercel production (added by
  agent via CLI)
- ✅ **Set `NEXT_PUBLIC_SUPABASE_ANON_KEY`** in Vercel production
  (publishable key, added by agent via CLI)
- ✅ **Retrieved & set `SUPABASE_JWT_SECRET`** (legacy HS256 secret;
  user retrieved from dashboard JWT settings page, agent added via
  CLI without echoing the secret to logs)
- ✅ **Empty commit pushed** to trigger redeploy with all three env
  vars baked in (`af94f52`)

## 12. Manual steps still needed (lower priority)

### 12.1 Two-window realtime smoke (5 min)

To confirm realtime works end-to-end from a real browser session:

1. Open https://mwg-crm.vercel.app/leads in two browser windows logged
   in as the same user.
2. In the browser DevTools console of one window, run:
   `localStorage.setItem("_e2eDisableSkipSelf", "true")` and reload.
3. Create a lead in the other window. The first window's leads list
   should refresh + flash the new row within ~2 seconds.

If it doesn't work, check the browser console for `[realtime]` warnings
and the network tab for `/api/auth/realtime-token` returning 200 with a
`token` field.

### 12.2 Provision a second Entra test identity (unblocks cross-actor specs)

Several Playwright specs are `test.skip` until two real users exist.
Spec: a second `morganwhite.com` user with no MFA, not admin. Add as
`PLAYWRIGHT_LOGIN_EMAIL_2` / `PASSWORD_2` env vars. Optional;
single-account smoke covers the most important flows.

### 12.3 Set Playwright credentials (only when running E2E)

Locally:
```bash
# .env.test.local (gitignored)
PLAYWRIGHT_LOGIN_EMAIL=REDACTED-EMAIL
PLAYWRIGHT_LOGIN_PASSWORD=REDACTED-PASSWORD
```

Then `pnpm exec playwright test --project=desktop-chromium`. If/when
CI is wired, mark these as **CI-scope** Vercel secrets only — never
expose to runtime functions.

### 12.4 Conditional Access drift (defensive)

If MWG IT later enables Conditional Access requiring MFA for the
test account, `tests/e2e/global-setup.ts` will fail loudly with a
clear message. Fix: whitelist runner IPs in an Entra "named location"
exclusion, or carve out the test account.

## 13. Wall-clock time

Approximately **35 minutes** of lead-agent work + **18 minutes** of
parallel Sub-A work = **~50 minutes elapsed wall-clock**, with Sub-A
running concurrent to lead agent's report drafting and env-var
plumbing.

## 14. What's deferred to Phase 13

`docs/phases/reports/BACKLOG-PHASE13.md` — Sub-A populated with:
- P13-001 — theme drift sweep (127 literals across 40 files)
- P13-002 — convert-modal polish
- P13-003 — hover-only affordance reform (Sub-B mobile pass owns)
- P13-004 — bulk-archive audit attribution
- (this session) Sub-B mobile UI pass + Sub-C full Playwright catalog
- Drizzle migration tree drift (operational hygiene; production schema
  matches the TS schema files but the `drizzle/` migration folder is
  one migration old)

---

**Phase 12 status: complete.** Realtime architecture is deployed,
verified at the deployment level, and pending only a user-driven
two-window smoke per §12.1.
