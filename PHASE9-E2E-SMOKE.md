# PHASE 9E — End-to-End Workflow Smoke

**Date:** 2026-05-07 21:35–21:42 CDT · **Mode:** live Playwright against
production at https://mwg-crm.vercel.app · **Actor:** breakglass admin
session.

---

## What was tested

A full Lead → Activities → Conversion → Close-Won flow, every step verified
against both the UI and the production database.

| # | Step | UI verdict | DB verdict |
|---|------|-----------|-----------|
| 1 | Sign in (pre-existing breakglass session) | dashboard renders | n/a |
| 2 | `/leads/new` create lead with 17 fields | redirected to detail page; all data shown | row `c9f31ecc-…` matches every input incl. subject + estimated_value 75000 + city/state |
| 3 | Lead detail Activity composer → Note | timeline appended | activity `218b292c-…` kind=note |
| 4 | Lead detail Activity composer → Log Call (subject, outcome=spoke, duration=22, body) | timeline appended | activity `bbd7ad69-…` kind=call, outcome=spoke, duration_minutes=22 |
| 5 | `/leads/[id]/edit` — change status→qualified, value→95000, add LinkedIn | redirected to detail; new values shown | UPDATE persisted, `version` 1→2 (OCC) |
| 6 | Convert modal — pre-fills account/contact/opp; submit | redirected to opportunity detail | lead.status=converted, account+contact+opportunity created with source_lead_id linkage; activities reassigned (lead_id NULL, opportunity_id set) |
| 7 | `/opportunities/pipeline` drag card → Closed Won | pipeline reflows after drop | opportunity.stage=closed_won, closed_at set, version 1→2 |
| 8 | `/accounts/[id]` shows "Customer since 05/07/2026" | text appears in header | derived from min(opportunities.closed_at) |
| 9 | `/accounts` shows Won deals = 1 | column populated | correlated subquery |
| 10 | Cmd+K search "Acme" | 3 results: lead, account, opportunity | hits FTS + trigram per Phase 4H |
| 11 | Hover owner chip on account detail | popover shows avatar + name + email + open leads/opps stats | `getUserProfileSummary` cache hit |
| 12 | Dashboard KPIs after conversion | Open leads 0, Conversion 100% | reflects post-convert state |
| 13 | `/leads` "My Open Leads" after fixes | empty (only lead is converted) | filter correctly excludes converted + soft-deleted |

## What was NOT tested live

- Entra SSO sign-in (cannot drive Microsoft auth from Playwright). Trace + DB
  evidence in `PHASE9-LOGIN-REFRESH-TEST.md`.
- Email send via Microsoft Graph (depends on Outlook permissions).
- Calendar invite scheduling (same).

## Bugs caught and fixed during the smoke

Two bugs surfaced **only** because of the comprehensive walkthrough — neither
was in the Phase 9A audits because both required a converted lead to surface:

### Bug 1 — soft-deleted leads visible across the UI

**Symptom (user-reported):** the soft-deleted "Wave Six Verifier" and
"Smoke Test" leads appeared in /leads "My Open Leads" despite
`is_deleted=true`.

**Root cause:** `runView` in `src/lib/views.ts` did not filter
`is_deleted=false`. Six other surfaces had the same gap:
- `src/app/(app)/dashboard/page.tsx` — every aggregation
- `src/lib/tasks.ts` — listTasksForUser/Lead/Open
- `src/app/(app)/contacts/[id]/page.tsx`, `opportunities/[id]/page.tsx`,
  `accounts/[id]/page.tsx` — detail-page selectors
- `src/lib/user-profile.ts:listOwnedLeads/Opportunities`

**Fix:** commit `79fc094` — added `is_deleted=false` to every site +
switched listOwnedLeads from `isNull(deletedAt)` to the canonical
`isDeleted=false` for consistency.

Already-correct sites preserved (verified): `/api/search`, `/leads/pipeline`,
the four list pages (Sub-D's cursor work), `lib/leads.ts`.

### Bug 2 — view filter overwrite via `extraFilters: undefined`

**Symptom:** after Bug 1 was fixed, "My Open Leads" still showed the
*converted* Phase Nine lead it should have hidden. The page-level builder
in `src/app/(app)/leads/page.tsx` always set `status: undefined` (and
similarly rating/source/tags) when no URL param was present. The naive
spread `{ ...view.filters, ...extraFilters }` in `runView` overwrote the
view's hard-coded `status: ['new','contacted','qualified']` with
`undefined`, so the IN clause was skipped entirely.

This had been latent since the extraFilters builder shipped — invisible
until a converted lead existed.

**Fix:** commit `963f8c9` — `runView` now iterates `extraFilters` and
assigns only when `value !== undefined`. View defaults survive when the
caller has nothing to layer on top. The Phase 9C `defaultExcludeStatuses`
escape hatch still works (it gates on `merged.status?.length`, not on
the spread).

## Console errors observed

Single 404 on `/favicon.ico` — pre-existing Phase 8 finding (5249), not
introduced this phase.

## Workflow data left in production

Test artefacts persist in production for the user to inspect or remove:

- Lead `c9f31ecc-6eac-4564-b1a7-ef033fce4459` "Phase Nine Walkthrough"
  (status=converted)
- Account `771407fc-a2e7-4f43-9e32-d474b3741e51` "Acme E2E Industries"
- Contact `92c32048-6eb6-4ba8-be6c-52e708998ec5` "Phase Nine Walkthrough"
- Opportunity `0f1ad3e3-2231-4e1f-9746-04f71f25497e`
  "Acme E2E Industries - 5/7/2026" (stage=closed_won, $95,000)
- 2 activities (note + call) attached to the opportunity

Not deleted because they are real evidence of the workflow working
end-to-end. The user can archive them via the UI or via SQL when
convenient.
