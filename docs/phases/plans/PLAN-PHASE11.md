# PLAN — Phase 11

> Generated 2026-05-08 — see `docs/phases/reports/PHASE11-AUDIT.md` for the
> findings that shape this plan.

## Themes (from the brief)

1. Breadcrumbs everywhere, data-aware.
2. Real-time multi-user updates (with the architectural caveats below).
3. Soft-delete read coverage — close the gaps Phase 10's write side opened.
4. Security audit pass — first dedicated since 4G; deeper than the surface.
5. Visual refresh — Airtable-style colored status/priority pills + row accents.
6. Reports — pre-built + custom builder + PDF export.

## Hard architectural deviations from the brief

The brief was written assuming the codebase uses the Supabase JS client +
TanStack Query + Framer Motion. None of those are dependencies.

| Brief assumed | Reality | Decision |
|---|---|---|
| `@supabase/supabase-js` for Realtime | not installed; app uses Drizzle + `postgres` directly | **polling-based realtime** for v1; Supabase Realtime channels are a Phase 12 follow-up |
| TanStack Query (`useQueryClient`, `setQueryData`) | not installed | use `router.refresh()` against Server Components |
| Framer Motion | not installed | CSS keyframes for the row-flash; no new dep |
| Supabase Realtime respects RLS | every public table has RLS enabled with **zero policies** (advisor confirms) | a JS Realtime subscription would be denied by RLS for everything; opening the gate would weaken security; defer until Phase 12 with proper RLS authoring |

The **polling approach** for v1: a small client hook polls
`/api/realtime/changes?entities=…&since=<iso>` every 10s when the tab is
visible (15s when not focused, paused on `visibilitychange:hidden`). The
endpoint queries `updated_at`/`is_deleted` per entity using the existing
session scope, returns a list of changed-since-X ids; the client calls
`router.refresh()` if any are present. The Server Components already
have the auth scope and re-render with current data. No new client-side
state-management library, no RLS to author, no realtime-channel config.
Visible row-flash is detected client-side by comparing pre/post DOM state
of `data-row-id` attributes inside a hydrated wrapper.

This delivers the brief's required UX ("two users on the same lead see
fresh data") with a worst-case 10–15s lag. Documented again in
`SECURITY-NOTES.md`.

## Order of operations

1. **11A — Audit** (this commit + `PHASE11-AUDIT.md`) ✓
2. **11B — Foundation** (single serial pass): breadcrumbs system, realtime
   polling hook + `/api/realtime/changes`, `withActive`/`withScope` helpers,
   color tokens, `<StatusPill>`/`<PriorityPill>`, `saved_reports` schema +
   scope helper, `<ConfirmDialog>` reuse for report deletion.
3. **11C — Three parallel sub-agents:**
   - **Sub-A:** wire breadcrumbs + the polling-realtime hook into every
     authenticated page family.
   - **Sub-B:** swap status/priority text for pills, audit every read query
     against soft-deletable entities (replace bare `eq(..isDeleted,false)`
     with helpers; add it where missing; document each archive-view
     exception).
   - **Sub-C:** Reports feature end-to-end (routes, builder, runner, PDF
     export, builtin-report seed).
4. **11D — Security deep pass** (lead, serial): the §6 checklist; fixes
   dispatched as needed; document everything in `PHASE11-SECURITY.md`.
5. **11E — Smoke test** with Playwright (`PHASE11-SMOKE.md`).
6. **11F — Final report** (`PHASE11-REPORT.md`) and final push.

## Out of scope

- Browser push notifications.
- Email-delivered reports / scheduled report runs.
- Cross-entity reports.
- Pivot tables.
- WebSocket/SSE channels (deferred to Phase 12 once RLS is authored).
- Re-enabling RLS with policies (Phase 12 — needs a thoughtful policy pass
  per table; out of scope to do under time pressure).
