# Phase 12C — Sub-A Final Report

**Date:** 2026-05-08
**Branch:** master (direct push, no PRs per project convention)
**Commits this phase:**
- `a9d3596` — feat: wire PageRealtime + RowRealtime across all entity pages
- `dc9aa6e` — feat: stamp updated_by_id on every entity UPDATE
- `9bd11fb` — fix: BUG-003 undo-toast surfaces NotFound when row hard-deleted

Three quality gates clean before each push: `pnpm tsc --noEmit`,
`pnpm lint`, `pnpm build`.

---

## 1. Realtime wiring (PRIMARY DELIVERABLE)

### Pages wired: 19 of 19 (100%)

| Route | `<PageRealtime>` | `<RowRealtime>` | Activity filter |
|---|---|---|---|
| `/dashboard` | leads, tasks, notifications | n/a | n/a |
| `/leads` (list) | leads | n/a | n/a |
| `/leads/[id]` | activities, tasks (filtered) | leads (focal) | `lead_id=eq.<id>` |
| `/leads/archived` | leads | n/a | n/a |
| `/leads/pipeline` | leads | n/a | n/a |
| `/accounts` (list) | accounts | n/a | n/a |
| `/accounts/[id]` | contacts, opportunities, activities | accounts (focal) | `account_id=eq.<id>` |
| `/accounts/archived` | accounts | n/a | n/a |
| `/contacts` (list) | contacts | n/a | n/a |
| `/contacts/[id]` | activities | contacts (focal) | `contact_id=eq.<id>` |
| `/contacts/archived` | contacts | n/a | n/a |
| `/opportunities` (list) | opportunities | n/a | n/a |
| `/opportunities/[id]` | activities, tasks | opportunities (focal) | `opportunity_id=eq.<id>` |
| `/opportunities/archived` | opportunities | n/a | n/a |
| `/opportunities/pipeline` | opportunities | n/a | n/a |
| `/tasks` | tasks | n/a | n/a |
| `/tasks/archived` | tasks | n/a | n/a |
| `/notifications` | notifications (filtered) | n/a | `user_id=eq.<self>` |
| `/reports/[id]` | dynamic per report.entityType | n/a | n/a |
| `(app)/layout.tsx` (topbar bell) | notifications (filtered) | n/a | `user_id=eq.<self>` |

### What landed where

- **`<PageRealtime entities={[…]} filter={…} />`** dropped in next to
  every existing `<PagePoll>` (per the Phase 12 architecture doc, the
  poll layer stays as documented fallback). `entities` accepts the
  same `RealtimeEntity` union as `<PagePoll>`; the component maps
  `accounts → crm_accounts` internally.
- **New `<RowRealtime entity={…} id={…} />`** at
  `src/components/realtime/row-realtime.tsx` (52 lines). Wraps
  `useRowSubscription` with a 150ms-debounced `router.refresh()`. Used
  on every `[entity]/[id]` detail page so single-row updates land in
  place without a page-wide refetch.
- **Layout-level notification subscription** — added `<PageRealtime
  entities={["notifications"]} filter={\`user_id=eq.${user.id}\`} />`
  inside `<RealtimeProvider>` in `src/app/(app)/layout.tsx` so the
  topbar bell updates everywhere without each page re-mounting it.
- **Reports runner** — `/reports/[id]` subscribes to its primary
  entity table via the existing `ENTITY_TO_REALTIME` map.

### Cleanup verified

- All consumers cleaned up on unmount (handled by the
  `useTableSubscription` hook's effect cleanup).
- All consumers respect skip-self (default true; `_e2eDisableSkipSelf`
  localStorage escape hatch unchanged).
- The 150ms `router.refresh()` debounce coalesces bursts so a Kanban
  drag that fires UPDATE + UPDATE + UPDATE (stage + position + version)
  triggers one refresh per drag, not three.

---

## 2. Actor stamping audit (#2)

Every server-action UPDATE path was walked. The Phase 12B migration
added `updated_by_id` to `crm_accounts`, `contacts`, `opportunities`,
`tasks`. Without stamping, skip-self breaks (the actor sees their own
write echoed back from the broker → infinite refresh loop).

### Fixes

| File | Function / line | Before | After |
|---|---|---|---|
| `src/lib/accounts.ts:110` | `archiveAccountsById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/accounts.ts:135` | `restoreAccountsById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/contacts.ts:82` | `archiveContactsById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/contacts.ts:102` | `restoreContactsById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/opportunities.ts:119` | `archiveOpportunitiesById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/opportunities.ts:139` | `restoreOpportunitiesById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/tasks.ts:252` | `updateTask` | no `updatedById` | `updatedById: actorId` |
| `src/lib/tasks.ts:262` | `archiveTasksById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/tasks.ts:292` | `restoreTasksById` | no `updatedById` | `updatedById: actorId` |
| `src/lib/leads.ts:551` | `archiveLeadsById` | no `updatedById` | `updatedById: actorId` |
| `src/app/(app)/opportunities/pipeline/actions.ts:69` | `updateOpportunityStageAction` | no `updatedById` | `updatedById: session.id` |

### Verified already correct

- `src/lib/leads.ts` `updateLead` (line 494) — already stamped
- `src/lib/leads.ts` `restoreLeadsById` (line 575) — already stamped
- `src/lib/conversion.ts` (line 171) — already stamped on convert
- `src/lib/leads.ts` `createLead` (line 467) — sets `updatedById` on insert (uniform with `createdById`)
- `src/app/(app)/leads/pipeline/actions.ts` `updateLeadStatusAction` — delegates to `updateLead` which stamps

### Activities — verified correct as-is

Activities use `user_id` (the author) per the Phase 12B realtime
architecture doc. `createNote` / `createCall` / `createTask` all set
`userId: input.userId` on insert; soft-delete and restore intentionally
preserve `user_id` for author attribution. The skip-self lookup chain
in `use-table-subscription.ts` falls through `updated_by_id →
created_by_id → user_id`, which is the correct semantic for activity
events. No `updateActivity` exists in the codebase — see BUG-001.

---

## 3. Concurrency / race hunt (#3)

### Findings (full ledger in PHASE12-BUGS.md)

| ID | Severity | Status | Disposition |
|---|---|---|---|
| BUG-001 | LOW | accepted | No `updateActivity` exists in the codebase. Reclassified. |
| BUG-002 | MED | deferred | Audit confirms `useFormStatus`/`useTransition` guards on all primary create forms (lead/account/contact/opportunity/task/composer/convert). Edge-case audit deferred. |
| BUG-003 | MED | **fixed (9bd11fb)** | Undo-toast now throws `NotFoundError` with the public message "<entity> — it was permanently deleted before Undo could run" instead of a misleading `ForbiddenError`. Activity undo path was already a silent no-op. |
| BUG-004 | LOW | deferred | Hover-only delete affordance on list rows — Sub-B mobile pass owns this. Listed in BACKLOG-PHASE13 P13-003. |
| BUG-005 | LOW | **fixed (dc9aa6e)** | Archive/restore helpers now stamp `updated_by_id` on all four entities + leads. |
| BUG-006 | LOW | **fixed (dc9aa6e)** | Pipeline DnD stamps `updatedById = session.id`. |
| BUG-007 | MED | **fixed (dc9aa6e)** | `updateTask` now stamps `updatedById`. |
| BUG-008 | LOW | accepted | Convert modal IS submission-locked via `useTransition`; server tx checks `lead.status` before insert. No fix. |
| BUG-009 | LOW | accepted | Notification fan-out partial-failure behavior is intentional — log per failure, keep going. |

### By severity (this phase)

- HIGH: 0
- MED: 4 (1 fixed, 1 deferred, 2 accepted/reclassified)
- LOW: 5 (3 fixed, 1 deferred, 1 accepted)

### Concurrency edges (PLAN-PHASE12.md §"Concurrency edges") status

- Two-tab same-user simultaneous archive: OCC version + skip-self handle this (verified by inspection of `archiveLeadsById`)
- Cross-owner activity delete: `canDeleteActivity` check fenced in the action; verified
- Admin force-delete with cross-owner activities: `softDeleteActivity` checks `isAdmin || row.userId === actorUserId`
- Notification fan-out partial failure: BUG-009 accepted
- Form double-submit: BUG-002 spot-checked, deferred for full sweep
- Soft-delete-while-open: F-046 (Phase 8D) `eq(leads.isDeleted, false)` filter on `updateLead` already prevents
- Hard-delete-while-open: would throw `NotFoundError` from `expectAffected`; UI shows the conflict toast
- Undo-toast firing 5s after admin already hard-deleted: **BUG-003 fixed** this

---

## 4. Theme drift (#4)

127 raw Tailwind palette literals across 40 files. **Far above the
50-line / few-file Sub-A bar — deferred to BACKLOG-PHASE13 P13-001**
with full reproduction commands and a recommended approach.

Hex color sweep: 64 occurrences across 5 files. All are intentional:
- `signin/microsoft-button.tsx` — Microsoft brand colors
- `globals.css` — token source itself
- print CSS files (lead/report) — print-only black/white
- `digest-email.ts` — email HTML can't read CSS variables

No theme-drift fixes shipped this phase.

---

## 5. What's deferred to Phase 13

- **P13-001** — 127 Tailwind palette literals → semantic tokens (40 files)
- **P13-002** — convert modal localStorage guard polish
- **P13-003** — hover-only affordances (also Sub-B's territory)
- **P13-004** — per-row audit attribution on bulk archive (no UI yet)
- **BUG-002** — full edge-case form double-submit sweep (image-upload forms not yet audited)

---

## 6. Files touched

**Realtime wiring (20 files, 1 new):**
- `src/components/realtime/row-realtime.tsx` (new, 52 lines)
- `src/app/(app)/layout.tsx` (added layout-level bell subscription)
- `src/app/(app)/dashboard/page.tsx`
- `src/app/(app)/leads/page.tsx`
- `src/app/(app)/leads/[id]/page.tsx`
- `src/app/(app)/leads/archived/page.tsx`
- `src/app/(app)/leads/pipeline/page.tsx`
- `src/app/(app)/accounts/page.tsx`
- `src/app/(app)/accounts/[id]/page.tsx`
- `src/app/(app)/accounts/archived/page.tsx`
- `src/app/(app)/contacts/page.tsx`
- `src/app/(app)/contacts/[id]/page.tsx`
- `src/app/(app)/contacts/archived/page.tsx`
- `src/app/(app)/opportunities/page.tsx`
- `src/app/(app)/opportunities/[id]/page.tsx`
- `src/app/(app)/opportunities/archived/page.tsx`
- `src/app/(app)/opportunities/pipeline/page.tsx`
- `src/app/(app)/tasks/page.tsx`
- `src/app/(app)/tasks/archived/page.tsx`
- `src/app/(app)/notifications/page.tsx`
- `src/app/(app)/reports/[id]/page.tsx`

**Actor stamping (6 files):**
- `src/lib/accounts.ts`
- `src/lib/contacts.ts`
- `src/lib/leads.ts`
- `src/lib/opportunities.ts`
- `src/lib/tasks.ts`
- `src/app/(app)/opportunities/pipeline/actions.ts`

**Bug fixes (4 files):**
- `src/app/(app)/leads/actions.ts`
- `src/app/(app)/accounts/actions.ts`
- `src/app/(app)/contacts/actions.ts`
- `src/app/(app)/opportunities/actions.ts`

**Documentation (2 files):**
- `docs/phases/reports/PHASE12-BUGS.md`
- `docs/phases/reports/BACKLOG-PHASE13.md`
- `docs/phases/reports/PHASE12-SUBA-REPORT.md` (this file)

---

## 7. Quality gates

All three gates clean on the final state:

```bash
pnpm tsc --noEmit  # exit 0
pnpm lint          # exit 0
pnpm build         # exit 0
```

Production deployed automatically by Vercel on each push to master.

End of report.
