# Phase 10A — Delete State Audit

Verified against the live `mwg-crm` Supabase project (`ylsstqcvhkggjbxrgezg`) on 2026-05-08 and against the codebase at commit `b0efb29`.

## Schema

`information_schema.columns` query confirmed soft-delete columns on five of six target tables:

| Table | `is_deleted` | `deleted_at` | `deleted_by_id` | `delete_reason` | `version` |
|---|:---:|:---:|:---:|:---:|:---:|
| `leads` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `crm_accounts` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `contacts` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `opportunities` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tasks` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `activities` | ❌ | ❌ | ❌ | ❌ | ❌ |

**Schema gap:** activities has no soft-delete columns and no `version` column. Phase 10B migration adds the soft-delete columns. Activities will not get a `version` column — they're append-only in spirit; the only mutation paths are create + delete, no edit.

## UI / server actions

| Entity | List trash | Detail Archive | Confirm modal | Audit logged | Restore view | Hard delete |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Lead | ❌ | ✅ inline button | ❌ (no modal) | ✅ `lead.archive` | ✅ `/leads/archived` | ✅ admin from archive |
| Account | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Contact | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Opportunity | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Task | ❌ | ❌ | ⚠️ `confirm()` | ⚠️ `task.delete` (hard) | ❌ | ❌ |
| Activity | n/a | ⚠️ inline link | ❌ | ✅ `activity.delete` (hard) | n/a (per spec) | n/a (per spec) |

### Findings

1. **Lead** — most complete. Detail page has inline Archive button (no confirm modal). Archive view exists with admin-only Restore + Hard-delete buttons. List page (`/leads`) has no per-row delete. Permission check uses `canDeleteLeads || isAdmin` — slightly looser than the brief's matrix (owner OR admin), but `requireLeadAccess` re-gates inside, and ownership-or-admin is honored. Phase 10 will additionally show the trash icon on list rows.

2. **Account / Contact / Opportunity** — zero delete affordances anywhere. No `archiveX`, `restoreX`, `hardDeleteX` server actions in the lib. The libs only export create + a few list helpers. Phase 10 must build the full delete stack for these three entities from scratch.

3. **Task** — `deleteTaskAction(id)` exists in `src/app/(app)/tasks/actions.ts` but does **HARD delete** (`db.delete(tasks)`) and has **no permission check** (any signed-in user can delete any task). This is a real security gap; Phase 10 closes it by replacing with soft-delete + creator/assignee/admin gate. The client UI (`task-list-client.tsx`) wraps it in a native `confirm()` — that's the only confirmation today.

4. **Activity** — `deleteActivityAction(formData)` already exists (lead-detail activity feed) and does HARD delete via `db.delete`. Permission check is correct (`isAdmin || activity.userId === user.id`). It's wired only on `/leads/[id]` — the equivalent activity tabs on Account / Contact / Opportunity detail pages don't exist yet (no activity feeds rendered there in this audit's scan). Phase 10 converts to soft-delete + recomputes `last_activity_at` on the parent.

5. **`canViewAllRecords` ≠ delete** — confirmed by reading `requireLeadAccess` and the per-entity gates: ownership OR admin OR `canViewAllRecords` grants *access*. The deleteLeadAction additionally requires `canDeleteLeads || isAdmin`, but does **not** auto-grant ownership-equivalent delete to `canViewAllRecords` users. The new per-entity `canDeleteX` helpers will be strict ownership-or-admin checks (no `canViewAllRecords`).

## Deferred from Phase 10

- Activity timeline rendering on Account / Contact / Opportunity detail pages — those pages don't render activity feeds today, so there's nothing to wire delete UI into. The lead-detail activity feed is the only surface.
- `version` column on activities — unnecessary; activities are append-only.
- Bulk-delete UX changes — the existing leads bulk-archive (Phase 4E) is out of scope; Phase 10 is per-row only.
