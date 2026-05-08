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
| BUG-010 | MED | sub-E mobile pass | Every authenticated page wrapper used `px-10 py-10` — 40px gutter that crowded 380px viewports below readability threshold | fixed (427a6be) | Sub-E | Replaced across 40 files with `px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10`. Desktop ≥1280px unchanged. |
| BUG-011 | MED | sub-E mobile pass | TanStack-style data tables had no mobile layout; horizontal scroll at <768px clipped action affordances | fixed (a37b8f3, 79e5afd, 6450a4c) | Sub-E | Added global CSS rule `.data-table-cards .data-table` that reflows rows to stacked cards at <768px. Wrappers + per-cell `data-label` attributes applied to /leads, /accounts, /contacts, /opportunities, and all five archived views. |
| BUG-012 | MED | sub-E mobile pass | ConfirmDeleteDialog + ConfirmHardDeleteDialog modals overflowed at <640px; cancel/archive buttons sometimes off-screen | fixed (95710a1) | Sub-E | New CSS pair `mwg-mobile-sheet` + `mwg-mobile-sheet-actions`. Modals collapse to a full-bleed bottom sheet at <640px with sticky action footer above `env(safe-area-inset-bottom)`. |
| BUG-013 | MED | sub-E mobile pass | Topbar breadcrumb chain overflowed at 380px; competing for space with search trigger and notifications bell | fixed (0f4c97c) | Sub-E | At <640px the trail collapses to a back-arrow Link (parent crumb) + leaf label only. The full chain re-shows at sm+. |
| BUG-014 | MED | sub-E mobile pass | Sidebar drawer had no <1024px equivalent; nav unreachable on phones | fixed (087613c, 95710a1) | Sub-E | New `<MobileSidebar>` Radix Dialog drawer; hamburger trigger lives in topbar; auto-closes on route change via render-time derived state (no useEffect setState). |
| BUG-015 | MED | sub-E mobile pass | dnd-kit Kanban boards did not respond to touch — drag never started on mobile | fixed (d4d1621) | Sub-E | Added `TouchSensor` with `{ delay: 200, tolerance: 8 }` to leads + opp pipeline boards. Outer scroll row gained `snap-x snap-mandatory`; each column gained `snap-start`. Header rows wrap. |
| BUG-016 | LOW | sub-E mobile pass | Convert lead modal was a custom flex-centered overlay — same overflow risk as Radix dialogs | fixed (70ebac4) | Sub-E | Convert modal flex container becomes `items-end` at <640px; inner glass surface caps at `max-h-[90dvh]` with bottom safe-area padding. |
| BUG-017 | LOW | sub-E mobile pass | Reports builder is desktop-first (side-by-side editor + preview), but at <1024px collapses unannounced | fixed (70ebac4) | Sub-E | Added an at-<1024px banner explaining the side-by-side preview falls below the editor on narrow viewports. The grid already collapses at <lg. Per build brief §"Sub-B mobile pass scope" the builder remains desktop-first. |
| BUG-018 | LOW | sub-E mobile pass | iOS Safari auto-zooms when a focused input/textarea/select font-size is <16px — every input on the CRM uses `text-sm` (14px) | fixed (087613c) | Sub-E | Global CSS rule at <640px enforces 16px on every native input/select/textarea (excluding checkbox/radio/range/color). Desktop keeps `text-sm` via Tailwind utilities. |
| BUG-019 | LOW | sub-E mobile pass | Hover-only delete affordances on coarse-pointer devices: confirm via grep audit | accepted | Sub-E | All hover-revealed icons (`DeleteIconButton`, opp pipeline card delete, activity-feed delete, task-list delete) already used `opacity-100 md:opacity-0 md:group-hover:opacity-100` — visible on touch by default. Added defensive `mwg-hover-reveal` CSS class + `(hover: none)` override in globals.css for any future hover-only patterns. |
| BUG-020 | LOW | sub-E mobile pass | Searchable selects → bottom sheets at <640px: deferred | deferred | Sub-E | The CRM uses native `<select>` elements throughout (no custom popover/cmdk surfaces in the entity flows). Native selects already render as iOS sheets / Android dropdowns — no custom primitive needed. Listed in BACKLOG-PHASE13.md if a custom searchable-select primitive lands. |

---

## Phase 12 Sub-E mobile pass — appended findings

End of seed. Sub-agents append below.
