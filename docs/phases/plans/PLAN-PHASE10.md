# Phase 10 — Visible Delete Affordances + Permission Gates

**Goal:** Owners can archive their own records; admins can archive anything; activity authors can delete their own activities. Confirm + Undo on every action. Audit-logged. No new features.

## Scope

| Entity | Soft-delete | Hard-delete |
|---|---|---|
| Lead | owner, admin | admin (from archive view) |
| Account | owner, admin | admin (from archive view) |
| Contact | owner, admin | admin (from archive view) |
| Opportunity | owner, admin | admin (from archive view) |
| Task | creator, assignee, admin | admin (from archive view) |
| Activity | author, admin | none from UI; cron purge after 30d |

## Sequence

1. **Phase 10A — Audit** (`PHASE10-DELETE-AUDIT.md`)
2. **Phase 10B — Foundation**
   - Migration: add soft-delete columns to `activities`
   - `src/lib/access/can-delete.ts` — pure ownership/admin helpers
   - `src/lib/actions/soft-delete.ts` — `performSoftDelete`, `performUndoSoftDelete`, `signUndoToken`, `verifyUndoToken`
   - `src/components/delete/`:
     - `confirm-delete-dialog.tsx` — Radix AlertDialog wrapper
     - `delete-icon-button.tsx` — list-row trash icon (hover-revealed)
     - `delete-button.tsx` — detail-page Archive button
     - `undo-toast.ts` — sonner helper
3. **Phase 10C — Per-entity wiring** (sequential, atomic per entity)
   - Leads: list-row trash + detail-page Archive (already exists; standardize), archive view (already exists; verify)
   - Accounts: list-row trash, detail-page Archive, `/accounts/archived` (new)
   - Contacts: list-row trash, detail-page Archive, `/contacts/archived` (new)
   - Opportunities: list-row trash, detail-page Archive, Kanban-card trash, `/opportunities/archived` (new)
   - Tasks: list-row trash, `/tasks/archived` (new) — replace existing hard-delete with soft-delete
   - Activities: timeline-card trash (already partially wired; convert to soft-delete + recompute `last_activity_at`)
4. **Phase 10D — Smoke test** (`PHASE10-SMOKE.md`)
5. **Phase 10E — Report** (`PHASE10-REPORT.md`)

## Decisions

- `canDeleteX(user, record)` is pure ownership/admin — explicitly does NOT honor `canViewAllRecords` or the legacy `canDeleteLeads` flag for non-Lead entities. Lead's existing `deleteLeadAction` already enforces ownership through `requireLeadAccess`; new entities follow the same gate but skip the redundant per-feature permission check (the matrix doesn't allow for it).
- Activities use HARD delete today (`db.delete`). Phase 10 converts to soft-delete with `last_activity_at` recompute on the parent.
- Undo token: HMAC-SHA256 over `{entity, id, deletedAt}` with `UNDO_SECRET` (env var). 5-second expiry.
- Admin hard-delete on activities is out — activities have no archive view per spec; the 30-day cron is the only purge path. Admin recovery is via audit log snapshots.
- Confirmation dialog uses Radix AlertDialog (`@radix-ui/react-alert-dialog`); add the dependency.
- Tasks current behavior: `deleteTaskAction(id)` does HARD delete with no permission check — this is a security gap that Phase 10 closes by replacing with soft-delete + ownership/assignee/admin gate.
