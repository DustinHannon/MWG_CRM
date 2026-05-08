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

**Sub-E completed in a follow-up wave** (commits `95710a1` through
`6450a4c`, 9 atomic commits + final report `3e3f826`). 28/28
authenticated routes covered at 380/414/768/1024 px, light + dark.
Top fixes: `data-table-cards` global pattern reflows TanStack tables
to stacked cards at <768px (9 list/archived pages); `mwg-mobile-sheet`
modal pattern collapses Radix Dialog/AlertDialog to full-bleed bottom
sheets at <640px with safe-area-bottom action footers; Kanban
`@dnd-kit/core` `TouchSensor` + snap-x scrolling on both pipeline
boards. Full inventory in `docs/phases/reports/PHASE12-SUBE-REPORT.md`.

Deferred (BUG-010..020): searchable-select bottom sheets (no custom
primitive — codebase uses native selects), reports/builder full
mobile rebuild (desktop-first per scope), activity emoji-picker
overflow, reports/[id] chart overflow audit, and two-window mobile
Playwright smoke (Sub-C's domain).

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

**Sub-D completed in a follow-up wave.** Reduced raw Tailwind palette
literals from **114 → 6 (-94.7%)** across 35 files using existing
`--status-*`, `--priority-*`, `--primary`, `--destructive`, `--muted`
tokens (no new tokens added to globals.css). Five commits: `85b8cbe`,
`ea435e5`, `06de67e`, `f57c467`, `a02eb40` + final report `500b296`.
Pattern set by the prior `85b8cbe` Pill refactor in `/leads`.

The remaining 6 literals (P13-001a) are all in pre-authentication
surfaces (`auth/disabled/page.tsx`, `auth/signin/{page,microsoft-button,signin-form}.tsx`)
where the dark glass aesthetic is theme-independent. Sub-D's
recommendation: pin `<html class="dark">` on the `(auth)` segment in
Phase 13 rather than tokenize.

## 8. Sub-agent results

> Note: SHAs below are the post-rewrite history (after the credential
> scrub). Original SHAs are gone; the work is preserved on the same
> linear timeline.

| Sub-agent | Outcome |
|---|---|
| **Sub-A — review + concurrency + realtime wiring** | 4 commits. 19/19 pages wired (100%). 11 actor-stamping fixes across 6 files. 9 ledger entries (3 fixed in-phase, 3 accepted after audit, 3 deferred). Final report `PHASE12-SUBA-REPORT.md`. |
| **Sub-D — theme drift sweep** | 5 atomic commits + final report. 114 → 6 raw Tailwind literals (-94.7%) across 35 files. No new tokens added. Final report `PHASE12-SUBD-REPORT.md`. Quality gates clean throughout. |
| **Sub-E — mobile UI pass** | 9 atomic commits + final report. 28/28 authenticated routes covered at 380/414/768/1024 px. Three reusable patterns introduced: `data-table-cards` (cell-stacked tables), `mwg-mobile-sheet` (bottom-sheet modal collapse), Kanban `TouchSensor`. 11 ledger entries (BUG-010..020). Final report `PHASE12-SUBE-REPORT.md`. |
| **Sub-C — Playwright catalog** | Foundation only (Phase 12B). Full catalog deferred to next session — needs `PLAYWRIGHT_LOGIN_*` env vars and a 2nd test identity for cross-actor specs. |

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
PLAYWRIGHT_LOGIN_EMAIL=<rotate-and-store-out-of-band>
PLAYWRIGHT_LOGIN_PASSWORD=<rotate-and-store-out-of-band>
```

**Note:** the original test credentials referenced earlier in this phase
were leaked to a public commit (71a09af, since rewritten — see commit
log) and MUST be rotated by MWG IT before any further E2E run. Treat
the previous password as compromised; assume an attacker has it.

Then `pnpm exec playwright test --project=desktop-chromium`. If/when
CI is wired, mark these as **CI-scope** Vercel secrets only — never
expose to runtime functions.

### 12.4 Conditional Access drift (defensive)

If MWG IT later enables Conditional Access requiring MFA for the
test account, `tests/e2e/global-setup.ts` will fail loudly with a
clear message. Fix: whitelist runner IPs in an Entra "named location"
exclusion, or carve out the test account.

## 13. Wall-clock time

- Lead agent: ~50 min (Phase 12A inventory through 12F report drafting + env-var plumbing + JWT-secret retrieval coordination)
- Sub-A (realtime wiring): ~18 min parallel
- Sub-D (theme drift): ~23 min parallel (in resume wave)
- Sub-E (mobile UI pass): ~30 min parallel (in resume wave)
- Security incident response (credential leak scrub + force-push + history rewrite): ~10 min serial

Total elapsed: **~115 minutes** wall-clock with significant parallel
overlap. Bare commits (excluding security/redeploy/report): 22.

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

**Phase 12 status: complete** (with the credential-rotation follow-up
in §15). Realtime architecture deployed, mobile pass shipped on every
route, theme drift reduced to 6 pre-auth literals.

## 15. Security incident: leaked test credentials

During §11.2 the lead agent inadvertently echoed the literal test
account email + password into `PHASE12-REPORT.md` (commit `71a09af`,
since rewritten). The user caught it. Response:

1. Stopped both running sub-agents to prevent rebase conflicts.
2. Replaced credentials with placeholders in 4 files (this report,
   `playwright.config.ts`, `tests/e2e/global-setup.ts`,
   `docs/realtime-architecture.md`).
3. `git filter-branch --tree-filter` rewrote every commit in every
   ref to substitute `<REDACTED-EMAIL>` / `<REDACTED-PASSWORD>` for
   the leaked strings, then `git push --force origin master`. The
   old commit SHAs (`71a09af`, `7c089d1`, `3d37839`, etc.) are now
   unreachable. Local reflog expired and `git gc --prune=now`.

**The leaked password is still compromised.** Force-push only stops
new clones from seeing it; existing clones, forks, GitHub Code Search
indexes, and Vercel rollback artifacts may still retain it. Required
follow-up actions for MWG IT:

- **Rotate the test account password immediately.** Treat the prior
  value as exposed to the public internet during the leak window
  (~14 min between push and force-push).
- **Audit Entra sign-in logs** for that account during the leak
  window for any anomalous activity.
- **Contact GitHub Support** at https://support.github.com → "I
  have leaked credentials in a public repo" and give them the leak
  SHA `71a09afe740b12e4aa20498638507db09792cc7e` so they can purge
  cached refs.
- **Check forks** at https://github.com/DustinHannon/MWG_CRM/network/members
  — forks retain old commits even after force-push.
- (Optional) Delete the Vercel rollback deployments `dpl_8XqXuZttht...`
  (the redeployed leak commit) from the project's deployment list, in
  case markdown docs were ever bundled into the build output. (They
  weren't in this build, but a rollback dashboard could still expose
  the old source bundle.)

This incident is documented to make future agents aware of the
risk of echoing user-pasted credentials back into committed
artifacts. The fix in this codebase is the explicit
NEVER-write-credentials rule now embedded in every sub-agent
prompt template.
