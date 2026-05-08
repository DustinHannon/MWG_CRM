# Phase 12 Inventory + Audit

**Date:** 2026-05-08
**Phase 12A scope:** §3 of build brief
**Author:** Phase 12 lead agent

This document is the spine of Phase 12. Sub-agents A/B/C in §5 of the build
brief consume it.

---

## 1. Feature inventory

| Feature | Phase | Primary route(s) | Server actions | Realtime needed? | Mobile-critical? |
|---|---|---|---|---|---|
| Lead CRUD | 1, 4, 10 | `/leads`, `/leads/[id]`, `/leads/new`, `/leads/[id]/edit` | createLead, updateLead, softDeleteLead, restoreLead, hardDeleteLead | yes | yes |
| Account CRUD | 5, 7, 10 | `/accounts`, `/accounts/[id]`, `/accounts/new` | createAccount, updateAccount, softDelete, restore, hardDelete | yes | yes |
| Contact CRUD | 5, 7, 10 | `/contacts`, `/contacts/[id]`, `/contacts/new` | createContact, updateContact, softDelete, restore, hardDelete | yes | yes |
| Opportunity CRUD | 6, 7, 10 | `/opportunities`, `/opportunities/[id]`, `/opportunities/new` | createOpportunity, updateOpportunity, softDelete, restore, hardDelete, advanceStage | yes | yes |
| Task CRUD | 3D, 7, 10 | `/tasks`, `/tasks/archived` | createTask, updateTask, completeTask, softDelete, restore, hardDelete | yes | yes |
| Activity feed | 6, 10 | embedded in entity detail pages, `/leads/[id]/activities` | createActivity, updateActivity, deleteActivity (soft) | yes | yes |
| Lead conversion | 3G | `/leads/[id]/convert` | convertLead (creates account+contact+opportunity in one tx) | yes | partial |
| Lead pipeline (Kanban) | 4D | `/leads/pipeline` | reorderLead, updateStatus | yes | partial |
| Opportunity pipeline (Kanban) | 6 | `/opportunities/pipeline` | advanceStage, reorderOpportunity | yes | partial |
| Archive views | 4G, 10 | `/leads/archived`, `/accounts/archived`, `/contacts/archived`, `/opportunities/archived`, `/tasks/archived` | restore, hardDelete | yes | partial |
| Notifications bell | 4 | topbar | markRead, markAllRead, clearAll | yes | yes |
| Notifications page | 4 | `/notifications` | markRead, markAllRead | yes | yes |
| Audit log admin | 4, 9 | `/admin/audit` | — | no | no |
| Search palette (cmdk) | 9 | global | — | no | yes |
| Saved views | 2F.1 | list pages (filters) | createSavedView, updateSavedView, deleteSavedView | no | partial |
| Tags admin | 4 | `/admin/tags` | tagCRUD | no | partial |
| Lead tag junction | 8D | per-lead | linkTag, unlinkTag | yes | partial |
| Lead scoring rules | 4C | `/admin/scoring` | scoringRule CRUD, rescore | no | desktop OK |
| Lead import (XLSX) | 8 | `/leads/import` | startImport job | no | desktop OK |
| Lead export (XLSX) | 8 | API | — | no | n/a |
| User profile | 9 | `/users/[id]`, `/settings` | updateUser, changePassword | no | partial |
| Admin users | 4, 9 | `/admin/users`, `/admin/users/[id]` | createUser, updateUser, deleteUser, reassignDelete | no | desktop OK |
| Admin data | 4 | `/admin/data` | exportAll, deleteAll | no | desktop OK |
| Admin settings | 4 | `/admin/settings` | rotateBreakglass, updateAppSettings | no | desktop OK |
| Reports — pre-built | 11 | `/reports`, `/reports/[id]` | runReport | yes | partial |
| Reports — builder | 11 | `/reports/builder` | createReport, updateReport, deleteReport | no | desktop OK |
| Report PDF/print | 11 | `/reports-print/[id]` | exportReportPdf | n/a | n/a |
| Breadcrumbs | 11 | every authenticated page | — | yes (data-aware updates) | yes |
| Auth (Entra SSO + breakglass) | 0, 1, 3 | `/auth/signin`, `/auth/disabled`, callbacks | — | n/a | yes |
| Cron — purge archived | 4G | `/api/cron/purge-archived` | — | n/a | n/a |
| Cron — rescore leads | 4C | `/api/cron/rescore-leads` | — | n/a | n/a |
| Cron — saved-search digest | 4 | `/api/cron/saved-search-digest` | — | n/a | n/a |
| Cron — tasks-due-today | 3D | `/api/cron/tasks-due-today` | — | n/a | n/a |
| Realtime poll API (Phase 11) | 11 | `/api/realtime/changes` | — | replaced by Supabase Realtime in Phase 12; kept as fallback | n/a |

---

## 2. Page inventory for the mobile pass

| Route | Current breakpoint behavior | Widest fixed element | Modal fits 380? | Sticky element issues? |
|---|---|---|---|---|
| `/dashboard` | KPI cards stack OK; 4 charts overflow at <768px | recharts container ~600px | n/a | none |
| `/leads` | Table scrolls horizontally at <1024px | TanStack table ~1100px | confirmDelete: yes | filter bar overflows on mobile |
| `/leads/[id]` | Side rail forced beside main content at <768px | side rail 320px | edit drawer overflows | none |
| `/leads/new` | Form OK | inputs full-width | n/a | none |
| `/leads/[id]/edit` | Form OK | inputs full-width | n/a | none |
| `/leads/[id]/activities` | Inline list; activity composer overflows on <640px | composer 100% but emoji picker pokes | yes | none |
| `/leads/[id]/convert` | Three-pane preview overflows on <1024px | preview ~1000px | yes | confirm bar |
| `/leads/[id]/graph` | Read-only Graph data; OK | n/a | n/a | none |
| `/leads/archived` | Same table issue as `/leads` | TanStack table | yes | none |
| `/leads/import` | Wizard steps OK | n/a | n/a | none |
| `/leads/pipeline` | Kanban — mostly desktop-tuned | each column 280px | n/a | sticky col header |
| `/accounts`, `/accounts/[id]`, `/accounts/new`, `/accounts/archived` | Same shape as leads | TanStack ~1000px | yes | none |
| `/contacts`, `/contacts/[id]`, `/contacts/new`, `/contacts/archived` | Same shape | TanStack ~900px | yes | none |
| `/opportunities`, `/opportunities/[id]`, `/opportunities/new`, `/opportunities/archived` | Same shape | TanStack ~1000px | yes | none |
| `/opportunities/pipeline` | Kanban; columns scroll horizontally | column 280px | n/a | sticky col header |
| `/tasks`, `/tasks/archived` | Table OK on tablet | TanStack ~900px | yes | none |
| `/notifications` | List OK | row 100% | n/a | none |
| `/reports` | Card grid ok | card 320px | n/a | none |
| `/reports/builder` | Side-by-side editor + preview overflows on <1024px | layout 1200px | n/a | save/run sticky bar |
| `/reports/[id]` | Table + chart panel | table varies | n/a | filter chips |
| `/reports/[id]/edit` | Same as builder | layout 1200px | n/a | none |
| `/users/[id]` | Profile cards, OK | photo + form | n/a | none |
| `/settings` | Tabs + form OK | inputs full-width | n/a | none |
| `/admin/audit` | Table + filters | table ~1100px | n/a | filters |
| `/admin/data` | Action buttons OK | n/a | yes | none |
| `/admin/scoring` | Rule table + builder | table ~900px | yes | none |
| `/admin/tags` | Table | tags ~600px | yes | none |
| `/admin/users`, `/admin/users/[id]` | Table | ~900px | yes | none |
| `/admin/settings`, `/admin/import-help`, `/admin/scoring/help`, `/admin/users/help` | Mostly text content; OK | n/a | n/a | none |

**Hover-only patterns to retire** (from a quick grep — Sub-B will validate):
- Trash buttons on list rows revealed via `group-hover:opacity-100`
- Inline edit pencils on side rails (`hover:visible`)
- "X" close on activity cards

**Topbar / sidebar:**
- Sidebar collapses to drawer at <1024px (already implemented per Phase 3A)
- Topbar at <640px keeps full breadcrumb + search input — overflows at narrow widths

---

## 3. Concurrency surface enumeration

OCC = optimistic concurrency control via `version` column. Leads, accounts (`crm_accounts`), contacts, opportunities, tasks, saved_reports, saved_views all have it. Activities and notifications do not.

| Mutation | Has `version`? | Has DB constraint? | Has audit? | Idempotent? | Notes |
|---|---|---|---|---|---|
| createLead | n/a | partial unique on email + dedup keys | ✅ | ❌ duplicate-submit risk | Form has no client-side submission lock (Sub-A) |
| updateLead | ✅ | — | ✅ | ❌ | OCC handles two-writer; conflict toast wired |
| softDeleteLead | ✅ | — | ✅ | ✅ | re-running is no-op |
| restoreLead | ✅ | — | ✅ | ✅ | ok |
| hardDeleteLead | n/a | — | ✅ | ✅ | admin-only override path |
| convertLead (transactional) | ✅ on lead | account-creation guards | ✅ | ❌ | clicking convert twice would attempt two conversions; verify |
| createAccount/Contact/Opportunity | n/a | various FKs | ✅ | ❌ | form-double-submit risk |
| update[Entity] | ✅ | — | ✅ | ❌ | OCC enforced |
| softDelete[Entity] / restore / hardDelete | ✅ where present | — | ✅ | ✅ | check soft-delete cascade matrix |
| createTask | n/a | — | ✅ | ❌ | duplicate-submit risk |
| updateTask | ✅ | — | ✅ | ❌ | OCC enforced |
| completeTask | ✅ | — | ✅ | ✅ on second click | should be no-op if already complete |
| createActivity | n/a | activities_one_parent CHECK | ✅ | ❌ | duplicate-submit risk; what if parent gets archived between form-load and submit? **Sub-A: verify access re-check on submit** |
| updateActivity | ❌ no version | — | ✅ | ❌ | **Race risk:** no OCC. Two concurrent edits → last-write-wins silently |
| deleteActivity (soft) | ❌ no version | — | ✅ | ✅ | re-running is no-op |
| undoSoftDelete via toast | ❌ token | — | ✅ | one-shot | token can fire after hard-delete? **Sub-A: verify** |
| reassignAssignment | ✅ on entity | — | ✅ | ❌ | two admins reassigning at once → OCC handles |
| markNotificationRead | n/a | — | ❌ | ✅ | ok |
| markAllRead | n/a | — | ❌ | ✅ | ok |
| runReport | n/a | — | ❌ (intentional) | ✅ | scope is viewer's per Phase 11 |
| createSavedReport | ✅ | — | ✅ | ❌ | |
| updateSavedReport | ✅ | — | ✅ | ❌ | |
| Realtime JWT mint | n/a | — | low-fidelity | ✅ | rate-limit per Phase 12B §4.4 |

**Notable findings already:**
- **No OCC on `activities`.** Two concurrent edits = silent last-write-wins. Phase 12 fix candidate (Sub-A).
- **No client-side submission lock** on any of the create-form server actions. Form-double-submit risk. Sub-A audits whether existing `<form action={...}>` already disables on pending; fixes any that don't.
- **`updateActivity`** is the only mutation that ships without OCC. Sub-A decides: add `version` column + OCC (small migration) or accept as low-traffic.

---

## 4. Realtime architecture audit (current state)

**Run via Supabase MCP `execute_sql` on 2026-05-08:**

### `pg_publication_tables WHERE pubname = 'supabase_realtime'`
**Result:** zero rows. Phase 11A's audit confirmed.

### `pg_tables WHERE schemaname = 'public'` — RLS state
All 24 public tables have `rowsecurity = true` (RLS enabled). This is intentional defense-in-depth from Phase 0; the app role `mwg_crm_app` has `BYPASSRLS` so server-side Drizzle is unaffected.

Tables: `accounts`, `activities`, `attachments`, `audit_log`, `contacts`, `crm_accounts`, `import_jobs`, `lead_scoring_rules`, `lead_scoring_settings`, `lead_tags`, `leads`, `notifications`, `opportunities`, `permissions`, `recent_views`, `saved_reports`, `saved_search_subscriptions`, `saved_views`, `sessions`, `tags`, `tasks`, `user_preferences`, `users`, `verification_tokens`.

### `pg_policies WHERE schemaname = 'public'`
**Result:** zero rows. All tables RLS-enabled with no policies = blocks all non-superuser/non-BYPASSRLS access. Server-side Drizzle bypasses; the realtime client connecting as role `authenticated` would see nothing.

### Implication
For Supabase Realtime to deliver events to the client, Phase 12B must:
1. Add the seven entity tables (`leads`, `crm_accounts`, `contacts`, `opportunities`, `tasks`, `activities`, `notifications`) to `supabase_realtime` publication.
2. Set `REPLICA IDENTITY FULL` on each so DELETE/UPDATE payloads include OLD-row data.
3. Create RLS `SELECT` policies for role `authenticated` on each table. Server-side Drizzle continues bypassing via the BYPASSRLS app role.

**Naming correction:** the build brief's spec uses `accounts` for the CRM account table. The actual SQL table is `crm_accounts` (the `accounts` SQL table is Auth.js's OAuth-account table). Phase 12B uses `crm_accounts`.

**Skip-self stamping correction:** the build brief assumes a `last_modified_by_id` column on every entity. Reality:
- `leads.updated_by_id` ✅ exists
- `crm_accounts`, `contacts`, `opportunities`, `tasks` — **do not** have an updated-by column
- `activities.user_id` ✅ exists (the activity author)
- `notifications` is recipient-only; no actor field needed (fan-out is intentional self-visible)

Phase 12B adds `updated_by_id` columns to `crm_accounts`, `contacts`, `opportunities`, `tasks` in a small additive migration. Sub-A's review walks every server action that updates these and ensures the stamp is set.

---

## 5. Supabase plan + current usage

### Project / org

- **Org:** Morgan White Group (`sinhwvbxpbhjdxuzmpaa`)
- **Plan:** **Pro** (already on Pro — confirmed via `mcp.get_organization`)
- **Project:** mwg-crm (`ylsstqcvhkggjbxrgezg`) in `us-east-1`, status `ACTIVE_HEALTHY`
- **Postgres:** 17.6.1.113 (engine 17, GA channel)

### Current usage (2026-05-08)

| Metric | Value | Pro tier ceiling | Headroom |
|---|---|---|---|
| Database size | **13 MB** | 8 GB | >99% (effectively unlimited) |
| Active users | **4** | 100K MAUs | >99% |
| Leads / Accounts / Contacts / Opportunities | 115 / 1 / 1 / 4 | n/a | n/a |
| Tasks / Activities / Notifications | 0 / 31 / 0 | n/a | n/a |
| Audit rows | 49 | n/a | n/a |
| Realtime concurrent peak (today) | 0 (publication empty) | 500 (Pro) | full |

### Recommendation (final form goes in Phase 12F report)

**Stay on Pro.** $25/mo. Current usage is far below every Pro ceiling. With realtime added, 4 concurrent users × ~3 channels each = ~12 concurrent realtime channels — well below Pro's 500-concurrent cap.

**Upgrade triggers (none currently met):**
- Team ($599/mo) — only if MWG's compliance auditors specifically require Supabase's own SOC 2 attestations folded into MWG's compliance package, or SSO into the Supabase dashboard for MWG IT.
- Enterprise (custom) — only if MWG requires a HIPAA Business Associate Agreement with Supabase, or if you exceed Pro's resource caps which is years away at current trajectory.

---

## 6. Production-only verification

```
git grep -nE "LOGIN_TEST_BYPASS|TEST_LOGIN_SECRET|test-login|test-auth" src/ tests/
```

**Result:** zero matches. No test-bypass auth artifacts exist.

```
git ls-files | grep -i playwright
```

**Result:** zero matches. No prior Playwright config / specs / fixtures exist.

```
git ls-files | grep -i 'staging\|preview-only'
```

**Result:** zero matches. No staging or preview-only docs/configs.

The CRM has one environment: production at `https://mwg-crm.vercel.app`. Phase 12 maintains this.

---

## 7. Existing realtime layer (Phase 11)

Phase 11 shipped a polling-based realtime:
- **Hook:** `src/hooks/realtime/use-realtime-poll.ts` — adaptive cadence (10s/30s/60s) with visibility + focus events
- **API:** `src/app/api/realtime/changes/route.ts` — returns IDs of records updated since `<iso>`, scoped to the viewer
- **Components:** `src/components/realtime/page-poll.tsx`, `row-flash.tsx`

**Phase 12 strategy:** Supabase Realtime becomes the primary push channel; the existing poll hook stays as the documented fallback (per build brief §5.3.3, where the "polling fallback" spec acknowledges the existing layer is acceptable). New `useTableSubscription` / `useRowSubscription` hooks are wired into pages; pages drop the poll hook OR keep both (push primary, poll secondary) — Sub-A decides per page.

---

## 8. Phase 12 plan (the spine)

1. **Phase 12B foundation** — install `@supabase/supabase-js` + `jose`; publication + RLS migrations; `updated_by_id` additive migration on entities missing it; JWT bridge endpoint; provider + hooks; wire `/leads` end-to-end; Playwright config + global setup; `PHASE12-BUGS.md` + `docs/known-races.md` seed.
2. **Phase 12C dispatch (parallel)** — Sub-A deep review + concurrency hunt + complete realtime wiring; Sub-B mobile pass; Sub-C Playwright suite.
3. **Phase 12D triage** — fix sweep, re-run Playwright per cluster.
4. **Phase 12E smoke** — two-window manual verification + final Playwright on desktop/mobile/tablet.
5. **Phase 12F report** — `PHASE12-REPORT.md` with Supabase plan recommendation, bug summary, manual user steps.

---

End of inventory. Foundation work begins.
