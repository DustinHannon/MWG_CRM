# Phase 6B — OCC backend wiring proof

> Last-write-wins on edit forms is now fixed. `concurrentUpdate` (built in
> Phase 4A but never wired) is the spine of every update path that takes
> a user-edited record. This file documents what was wired, what was
> intentionally skipped, and how to reproduce the conflict toast.

## What was wired

| Server action | File | Pattern | Form passes `version`? |
|---|---|---|---|
| `updateLeadAction` | `src/app/(app)/leads/actions.ts` | `lib/leads.ts:updateLead()` calls a versioned `db.update()` + `expectAffected` | Hidden input `name="version"` in `lead-form.tsx`, populated from `lead.version` on the edit page |
| `updateTaskAction` | `src/app/(app)/tasks/actions.ts` | `lib/tasks.ts:updateTask()` versioned UPDATE | Required field on the action's Zod schema; called from any task edit UI |
| `toggleTaskCompleteAction` | same | passes `expectedVersion` through to `updateTask` | `task-list-client.tsx` keeps a per-row version map updated optimistically |
| `updateViewAction` | `src/app/(app)/leads/view-actions.ts` | `lib/views.ts:updateSavedView()` versioned UPDATE | Hidden FormData field set from `views.find(v => v.id === savedDirtyId).version` in `view-toolbar.tsx` |
| `updatePreferencesAction` | `src/app/(app)/settings/actions.ts` | UPSERT with `setWhere: eq(version, expected)` — no row matched ⇒ `ConflictError` | `PreferencesSection`, `NotificationsSection`, `ThemeControl` (via parent `onSave`) each thread version through their state |

`concurrentUpdate` was used as the conflict-detection helper via the typed
`expectAffected(rowsReturned, ...)` companion — cleaner than the raw-SQL
`concurrentUpdate({...})` form for these existing Drizzle-builder paths.
The raw-SQL form remains available for callers that need it.

## What was intentionally skipped (and why)

- **Drag-drop status changes (`updateLeadStatusAction`, `updateOpportunityStageAction`).**
  These are single-field operations driven by drag events; the client
  doesn't currently know the row's `version`. Threading version through
  drag state is invasive and the UX is "last-drag-wins by user choice."
  Documented as deferred polish; not data-corrupting because the entire
  operation is a single column write.
- **`updateAccountAction`, `updateContactAction`, `updateOpportunityAction`.**
  These edit-form actions don't exist yet — those entities are view-only
  in the current UI. `concurrentUpdate` will be wired when the edit forms
  are added. ROADMAP.md updated to flag this.
- **The "polished" OCC banner UI from 5C.** Conflict still surfaces as a
  toast (`duration: Infinity, dismissible: true`) — the user reads, then
  refreshes, then re-edits. Banner with "View their changes" / names
  remains intentionally deferred.

## Two-tab smoke test

> Run this against the deployed app after the deployment goes green.

### Lead edit (the canonical test)

1. Sign in. Open the same lead in two browser tabs (e.g.,
   `/leads/<id>/edit` in tab A and tab B).
2. **Tab A:** change `Company` to "Test A". Click Save. → ✅ Saved, redirect
   to the lead detail page.
3. **Tab B (still showing the old company):** change `Notes`. Click Save.
   → ❌ Conflict toast appears: "This record was modified by someone
   else. Refresh to see their changes, then try again." Toast does not
   auto-dismiss.
4. **Tab B:** refresh the page (form reloads at `version+1`, with tab A's
   change visible). Make a different edit. Click Save.
   → ✅ Saved.

### Saved view (covers `updateViewAction`)

1. Open `/leads` in tab A and tab B with the same saved view selected.
2. **Tab A:** reorder columns and click "Save changes" → ✅
3. **Tab B:** reorder columns differently and click "Save changes" → ❌
   Conflict toast.
4. Refresh tab B → see tab A's column order → reorder again → save → ✅.

### Settings (covers `updatePreferencesAction` UPSERT path)

1. Open `/settings` in tab A and tab B.
2. **Tab A:** change Timezone. Auto-saves on change → ✅
3. **Tab B:** change Theme. Auto-saves → ❌ Conflict toast.
4. Refresh tab B → both changes from tab A visible → toggle theme again
   → ✅.

### Task toggle (covers `toggleTaskCompleteAction`)

1. Open `/tasks` in tab A and tab B with a shared open task.
2. **Tab A:** check the task complete → ✅ optimistic + saved.
3. **Tab B:** check the same task complete → ❌ Conflict toast (and the
   optimistic state rolls back).
4. Refresh tab B → task already shown completed → no further action.

## Acceptance

- [ ] All five tests above produce the expected toast on the second save.
- [ ] First save in each pair works with no regression vs. pre-Phase-6
      behavior.
- [ ] Toast remains visible until the user dismisses it (no auto-fade).
- [ ] Refreshing the conflicted tab brings it to the latest version
      and the next save works cleanly.
