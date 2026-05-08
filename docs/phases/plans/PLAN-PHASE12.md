# PLAN-PHASE12.md

> Companion to `PHASE12-INVENTORY.md`. Contains the executable bug-hunt scope
> for Sub-A and the dispatch checklist for the lead agent.

## Sub-A bug-hunt scope

For every mutating server action (per inventory §3), confirm:
- [ ] Reads `version` from form / accepts client-provided version
- [ ] Updates with `WHERE id = ? AND version = ?`
- [ ] Returns ConflictError on 0-row update
- [ ] Increments `version` in the SET clause
- [ ] Stamps `updated_by_id` (or `user_id` for activities)
- [ ] Writes audit_log row
- [ ] Idempotent retry behaves correctly (or documented why not)

Realtime wiring presence audit:
- [ ] `useTableSubscription('leads', …)` on `/leads`, `/leads/archived`, `/leads/pipeline`
- [ ] `useTableSubscription('crm_accounts', …)` on `/accounts`, `/accounts/archived`
- [ ] same for `/contacts`, `/opportunities`, `/opportunities/pipeline`, `/tasks`, `/tasks/archived`
- [ ] `useRowSubscription` on every `/[entity]/[id]` detail page
- [ ] `useTableSubscription('activities', …)` filtered by parent FK on every detail page's activity timeline
- [ ] `useTableSubscription('notifications', …)` filtered by `user_id=eq.<self>` on the bell + `/notifications`
- [ ] Reports runner page subscribes to its entity table and re-runs on debounce
- [ ] Every consumer cleans up on unmount
- [ ] Every consumer respects skip-self
- [ ] Every focused input/textarea preserved on foreign update; "X just changed this" indicator visible

Concurrency edges (per inventory §3):
- Two-tab same-user simultaneous archive of same record
- Cross-owner activity delete on someone else's lead
- Admin force-delete with cross-owner activities (override path)
- Notification fan-out partial failure (one disabled recipient out of N)
- Form double-submit on every create form
- Soft-delete-while-open (banner switches detail page to read-only)
- Hard-delete-while-open (same)
- Undo-toast firing 5s after admin already hard-deleted

Theme / logic drift:
- Run grep for hex colors and raw Tailwind palette in app code; replace with tokens from `:root` / `.dark`
- Audit confirm modals — should all be `<ConfirmDeleteDialog>`. Flag forks.
- Audit empty states / skeletons / date formatters for one canonical shape each.

Append every finding to `PHASE12-BUGS.md` (created in 12B).

---

## Sub-B mobile pass scope

For every authenticated route in inventory §2 at viewports 380 / 414 / 768 / 1024 px:
- No horizontal overflow
- Tables convert to cards at <768px
- Hover-revealed actions become always-visible on `(hover: none)`
- Modals full-screen at <640px with sticky cancel/confirm above safe-area
- Inputs ≥16px font to suppress iOS zoom
- Searchable selects become bottom sheets
- Kanban scrolls horizontally with snap; touch-drag works

Desktop ≥1280 must not regress.

Both light and dark themes verified at every viewport.

---

## Sub-C Playwright scope

Catalog of spec files in build brief §5.3.1. Mandatory specs in §5.3.3.

Cross-actor specs (`permissions.spec.ts`, multi-user `realtime.spec.ts`) are
explicitly `test.skip` pending second test identity. Realtime two-context
specs use the `_e2eDisableSkipSelf` localStorage escape hatch (single-account
constraint).

Production-only:
- `baseURL = https://mwg-crm.vercel.app`
- `workers: 1`, `fullyParallel: false`
- `E2E_RUN_ID` tags every test-created record
- `cleanup.ts` purges by tag in `globalTeardown`
- `audit_log.metadata.e2e_run_id` set via `X-E2E-Run-Id` header on every request

---

## Phase 12B serialized checklist

1. `pnpm add @supabase/supabase-js jose`
2. Migration `phase12_realtime_publication.sql` — add 7 tables + REPLICA IDENTITY FULL
3. Migration `phase12_realtime_rls.sql` — `auth.user_id()`, `auth.is_admin()`, `auth.can_view_all()` + 7 SELECT policies (uses `crm_accounts` not `accounts`)
4. Migration `phase12_actor_stamping.sql` — add `updated_by_id` to `crm_accounts`, `contacts`, `opportunities`, `tasks`
5. `src/app/api/auth/realtime-token/route.ts` — JWT mint, joins users + permissions
6. `src/lib/realtime/client.ts` + `src/components/realtime/provider.tsx`
7. `src/hooks/realtime/use-table-subscription.ts` + `use-row-subscription.ts`
8. CSS flash classes in `src/app/globals.css`
9. Mount `<RealtimeProvider>` in `src/app/(app)/layout.tsx`
10. Wire `/leads` list + detail as canonical proof
11. Update server actions for leads to stamp `updated_by_id` (most already do via `concurrentUpdate` helper — verify)
12. `playwright.config.ts` + `tests/e2e/global-setup.ts` + `tests/e2e/cleanup.ts`
13. Add `tests/e2e/.auth/` and `.env.test*` to `.gitignore`
14. `X-E2E-Run-Id` plumbing — middleware reads header and writes to `audit_log.metadata.e2e_run_id`
15. `/admin/audit` "Hide E2E test traffic" toggle (default ON)
16. Seed `PHASE12-BUGS.md` + `docs/known-races.md`
17. Push to master, verify deploy, manually verify two-window realtime works on `/leads`

Then dispatch sub-agents.
