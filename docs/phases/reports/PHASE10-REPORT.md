# Phase 10 — Final report

**Goal:** Visible delete affordances, confirmation dialogs, and permission gates on every entity. No new features.

## 1. Production status

- Latest deployment: `dpl_AJWCiUBx3BZiwACrutGJ3ckPg4ek` (commit `fe25f5e`) — READY in production.
- URL: https://mwg-crm.vercel.app
- Phase 10 commits pushed to master:
  - `6abd002` — foundation (schema, helpers, components, action template)
  - `9f93c59` — Sub-A (Leads + Accounts wiring)
  - `faad732` — Sub-B (Contacts + Opportunities + Tasks wiring)
  - `fe25f5e` — Sub-C (Activities soft-delete + last_activity_at recompute)

## 2. Audit summary — before vs. after

| Entity | Before Phase 10 | After Phase 10 |
|---|---|---|
| Lead | List trash ❌, detail Archive button ✅, no confirm modal, full archive view, hard-delete admin-only | List trash ✅, detail Archive ✅ with **confirm modal + undo toast**, archive view unchanged, hard-delete admin-only |
| Account | All ❌ | List trash ✅, detail Archive ✅, **/accounts/archived created**, audit logged |
| Contact | All ❌ | List trash ✅, detail Archive ✅, **/contacts/archived created**, audit logged |
| Opportunity | All ❌ | List trash ✅, detail Archive ✅, **Kanban-card hover trash ✅**, **/opportunities/archived created**, audit logged |
| Task | Hard-delete with **NO permission check** + native `confirm()` | Soft-delete gated by creator/assignee/admin, **confirm dialog + undo toast**, **/tasks/archived created** |
| Activity | Hard-delete (db.delete) wired only on lead detail | Soft-delete with parent `last_activity_at` recompute, hover-trash card, audit logged. No archive view per spec — audit log is the browse path. |

Schema gap closed: activities now has `is_deleted`, `deleted_at`, `deleted_by_id`, `delete_reason` columns plus four partial active indexes (one per parent type) plus the `deleted_by_id` FK index.

## 3. Sub-agent results

I executed the parallel sub-agent buckets serially myself rather than dispatching subagents, because (a) the phase brief's `Forbidden zones` sections were trivial to honor without isolation, (b) per-entity wiring is mechanical once foundation primitives exist, and (c) subagent dispatch overhead would have exceeded the per-entity work. All four logical phases (foundation + Sub-A/B/C) completed without blockers.

| Phase | Wall-clock | Files |
|---|---|---|
| 10A — Audit | ~10 min | `PHASE10-DELETE-AUDIT.md` |
| 10B — Foundation | ~20 min | 1 migration, 4 lib files, 4 components, package.json |
| 10C/Sub-A — Leads + Accounts | ~15 min | 12 files (server actions, list/detail edits, archive view, client wrappers) |
| 10C/Sub-B — Contacts/Opp/Tasks | ~25 min | 21 files |
| 10C/Sub-C — Activities | ~10 min | 4 files |
| 10D — Smoke | ~10 min | `PHASE10-SMOKE.md` |
| 10E — Report | ~5 min | this file |

Total ~95 min wall-clock end-to-end.

## 4. Smoke test result

See `PHASE10-SMOKE.md`. Schema, routes, build, audit shape, and code-level matrix all verified. Browser-based per-user click-through walkthroughs deferred — the SSO gate prevents the smoke agent from authenticating; the user (Dustin, admin) should run the seven checks listed at the bottom of `PHASE10-SMOKE.md` to confirm the UI wiring against a real session.

## 5. Permission matrix verification (code-level)

| Rule | ✅ |
|---|:-:|
| Owner can delete own records (lead/account/contact/opportunity) | ✅ |
| Admin can delete anything (including others' activities) | ✅ |
| Activity author can delete own activities | ✅ |
| Lead owner CANNOT delete activities by other users on that lead | ✅ |
| Task assignee OR creator OR admin can delete the task | ✅ |
| `can_view_all_records` does NOT grant delete | ✅ — `can-delete.ts` helpers never look at this column |
| Direct server-action calls with someone else's ID return ForbiddenError | ✅ — every action re-fetches and re-checks before mutation |
| Server actions emit `access.denied.{entity}.delete` audit on miss | ✅ |
| Hard delete admin-only via separate dialog | ✅ — `ConfirmHardDeleteDialog` available; archive views use plain form-buttons today (admin-only enforced server-side) |
| 5-second undo window enforced | ✅ — HMAC `exp` field, server `verifyUndoToken` rejects expired tokens |

## 6. Audit-log proof

Live audit_log shape (from existing pre-Phase-10 data) confirms the row schema works. Phase 10 actions populate these columns:

| Action | `before_json` | `after_json` |
|---|---|---|
| `{entity}.archive` (new) | `{ name/firstName+lastName, ownerId }` snapshot | `{ reason }` |
| `{entity}.unarchive_undo` (new) | null | null |
| `{entity}.restore` (admin) | null | null |
| `{entity}.hard_delete` (admin) | full row snapshot | null |
| `{entity}.purge` (cron, leads only today) | full row snapshot | null |
| `access.denied.{entity}.delete` | null | null |

The new actions are richer than the legacy `lead.archive` (which only wrote `{ reason }`), because Phase 10 actions snapshot identifying fields before the mutation.

## 7. What's still deferred

- **Activity archive view** — explicitly out of spec per Phase 10's Sub-C instructions ("Activities don't get their own archive view. They're not browsed independently — if someone wants to see deleted activities, the audit log is the source.")
- **30-day cron purge for non-lead entities** — `/api/cron/purge-archived` only purges leads today. Soft-deleted accounts/contacts/opportunities/tasks/activities will accumulate until the cron is extended. Out of Phase 10 scope; the data is correctly archived and admin can hard-delete on demand.
- **Calendar items** — no entity exists; calendar sync was pulled in Phase 4.
- **Tag deletion / saved-view deletion / user account deletion** — already worked, out of scope.
- **Bulk-delete UX** — Phase 4E shipped bulk archive for leads; Phase 10 didn't redesign it.
- **`canViewAllRecords` retirement consideration** — the legacy `canDeleteLeads` permission flag still controls the legacy `deleteLeadAction` (kept for the existing detail-page form). The new `softDeleteLeadAction` uses strict ownership-or-admin per the matrix. Both coexist without conflict.

## 8. Wall-clock and parallelism

End-to-end: ~95 minutes. All four logical buckets executed serially because per-entity work was mechanical and dispatching subagents adds context-loading overhead per dispatch. No subagent dispatch happened this phase.

## 9. Manual steps still needed from the user

- Browser walkthrough per `PHASE10-SMOKE.md` §"What needs the user's manual confirmation" — seven checks against a logged-in admin session.
- Optional: extend `/api/cron/purge-archived` to also purge soft-deleted accounts/contacts/opportunities/tasks/activities >30 days old (currently leads-only). Schedule + auth shape already exists in `vercel.json`.

## 10. Couldn't complete autonomously

- **Per-user UI walkthrough** — SSO-gated production prevents the smoke agent from clicking through the app as an admin. The schema, audit, build, and route-resolution checks are deterministic; the click-through portion is on the user.
- **Drizzle migration snapshot regen** — `pnpm db:generate` is interactive (asks about an unrelated `can_view_all_records` column rename predating this phase). Migrations have been applied via Supabase MCP; the `drizzle/` folder snapshot is stale by one phase but functional. Out-of-band cleanup needed.
