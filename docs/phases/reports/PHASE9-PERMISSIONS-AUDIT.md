# PHASE 9A — Permissions Wiring Audit

**Date:** 2026-05-07 · **Auditor:** Phase 9 lead agent · **Mode:** read-only.

Goal: identify "fake permissions" (toggleable in admin UI but read by zero code) and document the full flag → effect map for `/admin/users/help`.

Method: `grep -rn` across `src/` for each flag, classify each read site, then trace whether the gate is actually invoked.

Source: master `1e704f3` (post-Phase 8). Schema in `src/db/schema/users.ts:84–107`.

---

## Schema flags

`permissions` table columns (Drizzle: `src/db/schema/users.ts:84–107`):

| Flag | Default | In admin UI? |
|---|---|---|
| `can_view_all_records` | false | ✅ shown (label "View all leads") |
| `can_create_leads` | true | ✅ shown |
| `can_edit_leads` | true | ✅ shown |
| `can_delete_leads` | false | ✅ shown |
| `can_import` | false | ✅ shown |
| `can_export` | false | ✅ shown |
| `can_send_email` | true | ✅ shown |
| `can_view_reports` | true | ✅ shown |
| `can_view_team_records` | false | ❌ NOT shown (Phase 5E deferred) |

Plus user-level booleans: `is_admin`, `is_active`, `is_breakglass` — handled in `auth-helpers.ts:requireAdmin` / `requireSession`.

---

## Per-flag verification

### `canViewAllRecords` ✅ wired

Read by:
- `src/lib/access.ts:37–42` — central `loadPerms()` for entity gates.
- `src/lib/auth-helpers.ts:124–126` — `requireLeadAccess` legacy gate.
- `src/app/(app)/leads/page.tsx`, `accounts/page.tsx`, `accounts/[id]/page.tsx`, `contacts/page.tsx`, `contacts/[id]/page.tsx`, `opportunities/page.tsx`, `opportunities/[id]/page.tsx`, `dashboard/page.tsx`, `leads/pipeline/page.tsx`, `opportunities/pipeline/page.tsx` — owner-scope filter.
- `src/app/api/leads/check-duplicate/route.ts`, `src/app/api/leads/export/route.ts`, `src/app/api/search/route.ts`.

Toggle test: with flag OFF, queries are scoped to `owner_id = userId`. Flag ON: scope opens. Wired end-to-end.

### `canCreateLeads` ✅ wired

Read by:
- `src/app/(app)/leads/actions.ts:76` — `createLeadAction` server-side gate (throws ForbiddenError).
- `src/app/(app)/leads/new/page.tsx:10` — page-level redirect on miss.
- `src/app/(app)/leads/page.tsx:201`, `dashboard/page.tsx:196` — UI toggle for "+ New" button.

Wired.

### `canEditLeads` ✅ wired

Read by:
- `src/lib/auth-helpers.ts:148–157` — `requireLeadEditAccess` (server-side).
- `src/app/(app)/leads/[id]/edit/page.tsx:17` — page-level redirect.
- `src/app/(app)/leads/[id]/page.tsx:39` — UI toggle for Edit button.

Wired.

### `canDeleteLeads` ✅ wired

Read by:
- `src/app/(app)/leads/actions.ts:195` — `deleteLeadAction` server-side gate.
- `src/app/(app)/leads/[id]/page.tsx:40` — UI toggle for Archive button.
- `src/lib/access.ts:38` — loaded but currently unused (loaded for future tightening of `requireXAccess(action="delete")`). Acceptable.

Wired.

### `canImport` ✅ wired

Read by:
- `src/app/(app)/leads/import/actions.ts:59,175` — `previewImportAction` + `commitImportAction`.
- `src/app/(app)/leads/import/page.tsx:10` — page-level redirect.
- `src/app/(app)/leads/page.tsx:185`, `dashboard/page.tsx:204` — UI toggle.
- `src/app/api/leads/import-template/route.ts:8` — template download gate.

Wired.

### `canExport` ✅ wired

Read by:
- `src/app/(app)/leads/page.tsx:193` — UI toggle.
- `src/app/api/leads/export/route.ts:9` — XLSX export endpoint gate.

Wired.

### `canSendEmail` ✅ wired

Read by:
- `src/app/(app)/leads/[id]/graph/actions.ts:30` — email send action.
- `src/app/(app)/leads/[id]/page.tsx:213` — UI toggle for the Graph action panel.

Wired.

### `canViewReports` ❌ FAKE PERMISSION

Read sites: **none functional.**

```
src/db/schema/users.ts:99           — schema declaration
src/lib/auth-helpers.ts:65          — type union
src/lib/auth-helpers.ts:179,191     — default + select projection
src/lib/breakglass.ts:87            — breakglass init
src/lib/entra-provisioning.ts:206   — provision init
src/app/admin/users/[id]/actions.ts:26 — admin update list
src/app/admin/users/[id]/page.tsx:23   — admin UI label
```

**Zero code reads it as a gate.** It is shipped as a toggle in `/admin/users/[id]` ("View reports — Access dashboard analytics") but flipping it has no effect. The `/dashboard` page does not check it.

**Sub-agent C must:** either wire it (gate `/dashboard` and the dashboard server-side queries), OR remove it from schema + admin UI + provisioning. Recommendation: **wire it** — non-managers shouldn't see org-wide rollups, and "view reports" is a sensible gate name. Currently `/dashboard` is implicitly accessible to every signed-in user.

### `canViewTeamRecords` ⚠️ deferred (intentional)

Read sites: **schema only.**

```
src/db/schema/users.ts:106 — schema declaration only
```

Not read anywhere. Not in `auth-helpers.ts:PermissionKey`. Not in `getPermissions()`. Not surfaced in `/admin/users/[id]`. Documented as Phase 5E deferred work in the schema comment: *"Access-gate wiring + entity-level UI surfaces are tracked in ROADMAP — schema landed first so the column is available for future work."*

**Sub-agent C action:** leave column as-is (don't drop). Document in `/admin/users/help` as "reserved — manager linking ships in a future phase". Since the toggle is NOT exposed in admin UI, no UI greying-out is needed.

---

## Settings re-audit cross-check

The brief asks for a re-walk of every `/settings` control (Phase 5A audit format extended). Sub-agent C's scope. Bullet list of controls to re-verify (loaded from `src/app/(app)/settings/page.tsx`):

- Theme (System / Light / Dark)
- Default landing page
- Default leads view
- Time zone
- Date format
- Time format
- Table density
- Notification preferences
- Email digest frequency
- Microsoft 365 connection card (Reconnect, Disconnect)
- "Sign out everywhere" button

For each: confirm save + reload + apply. Anything ❌ → fix.

---

# Sub-agent C task list

Priority order:

1. **Wire `canViewReports`**:
   - `auth-helpers.ts` already includes it in the union — add a `requirePermission(user, "canViewReports")` gate at the top of `src/app/(app)/dashboard/page.tsx`.
   - When flag is OFF: redirect to `/leads` (no reports access).
   - Test: breakglass with `canViewReports=false` should hit `/dashboard` and bounce.
   - Optional: hide the "Dashboard" nav item for users without the flag in `src/app/(app)/layout.tsx:APP_NAV` (filter at render time).
2. **Document `canViewTeamRecords` as deferred** in `/admin/users/help`.
3. **Build `/admin/users/help`** — static page (admin-only) with the full flag → effect table:

   | Flag | What it does | Default |
   |---|---|---|
   | `canViewAllRecords` | See leads/accounts/contacts/opportunities owned by other users. Bypasses owner scope on every list and detail page. | OFF |
   | `canCreateLeads` | Create new leads. Without it, "+ New" is hidden and `createLeadAction` rejects. | ON |
   | `canEditLeads` | Modify lead fields. Without it, the Edit button is hidden and `updateLeadAction` rejects. | ON |
   | `canDeleteLeads` | Archive leads. Without it, the Archive button is hidden and `deleteLeadAction` rejects. | OFF |
   | `canImport` | Use `/leads/import`. Without it, the Import button is hidden and the import server actions reject. | OFF |
   | `canExport` | Download filtered leads as XLSX. Without it, the Export button is hidden and `/api/leads/export` rejects. | OFF |
   | `canSendEmail` | Send email from the lead detail page. Without it, the email panel is hidden. | ON |
   | `canViewReports` | Access `/dashboard` analytics. Without it, dashboard redirects to `/leads`. | ON |
   | `canViewTeamRecords` | *(reserved — manager linking ships in a future phase)* | OFF |
   | Admin (separate field) | Bypasses every flag above. Plus access to `/admin`. | OFF |

4. **Re-audit settings controls** — write `PHASE9-SETTINGS-AUDIT.md` with two-row test (set, navigate away, come back, observe applied) for each control listed above. Fix any ❌.

Forbidden zones (carry-over from §6.3): no schema changes beyond permission flag additions (none needed in this audit), no touching foundation components, no overlap with Sub-agents A/B/D.
