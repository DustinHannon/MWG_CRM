# Phase 12 — Bug ledger

> One row per finding. Sub-A appends concurrency / theme / logic-drift
> findings; Sub-B appends mobile findings; Sub-C appends test failures.
>
> Severity: **HIGH** = data integrity / privilege escalation;
> **MED** = user-visible incorrectness or noisy UX;
> **LOW** = cosmetic / minor.
>
> Status: **open / fix-in-progress / fixed (commit) / accepted (link)
> / deferred (BACKLOG-PHASE13.md)**.

| ID | Severity | Source | Title | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| BUG-001 | LOW | inventory §3 | `updateActivity` has no `version` / OCC; concurrent edits silently last-write-wins | accepted | Sub-A | No `updateActivity` exists in the codebase. Activities are immutable except soft-delete. CHECK (`activities_one_parent`) plus the soft-delete recompute of `parent.last_activity_at` is the only mutation path. Reclassified as accepted — no fix needed. |
| BUG-002 | MED | inventory §3 | No client-side submission lock on create forms (lead/account/contact/opportunity/task) — double-submit risk | deferred | Sub-A | Audit found `useFormStatus().pending` on lead/account/contact/opportunity create forms (verified in `*\/new\/_components\/*-form.tsx`). Tasks composer + activity composer also `useTransition`-gated. Real risk: image-upload forms and ConvertModal. Deferred to Phase 13 — see BACKLOG. |
| BUG-003 | MED | inventory §3 | Undo-toast token can fire after admin hard-deletes the record | fixed (dc9aa6e+) | Sub-A | Now throws `NotFoundError` with public message "<entity> — it was permanently deleted before Undo could run" on lead / account / contact / opportunity undo paths. Activity undo path was already a silent no-op via `restoreActivity` returning empty parentKind. |
| BUG-004 | LOW | sub-A audit | Hover-only delete affordance on list rows (`group-hover:opacity-100`) — invisible on touch devices | deferred | Sub-A | Sub-B mobile pass owns this. Listed in BACKLOG-PHASE13. |
| BUG-005 | LOW | sub-A audit | `restoreLeadsById` and 3 sister archive helpers previously did not stamp `updated_by_id`, causing realtime feedback loops on archive/restore via skip-self failure | fixed (dc9aa6e) | Sub-A | All four entities + leads now stamp `updatedById` on archive AND restore. |
| BUG-006 | LOW | sub-A audit | `updateOpportunityStageAction` (kanban DnD) did not stamp `updated_by_id` | fixed (dc9aa6e) | Sub-A | Pipeline DnD now stamps `updatedById = session.id`. |
| BUG-007 | MED | sub-A audit | `updateTask` did not stamp `updated_by_id` despite the column existing | fixed (dc9aa6e) | Sub-A | Added `updatedById: actorId` to the SET clause inside `updateTask`. |
| BUG-008 | LOW | sub-A audit | `convertLead` modal — verify race between status check and tx | accepted | Sub-A | The convert modal IS submission-locked via `useTransition`; the server tx also checks `lead.status` before insert. Verified in `src/app/(app)/leads/[id]/convert/_components/convert-modal.tsx`. No fix needed. |
| BUG-009 | LOW | sub-A audit | Notification fan-out on saved-search digest cron does not roll back partial failures (one disabled recipient does not abort the rest) | accepted | Sub-A | Intentional — failure to deliver to one user shouldn't block the rest. The cron logs each failure; idempotency via `notifications` unique scope keeps replays safe. Documented here for visibility. |

---

End of seed. Sub-agents append below.
