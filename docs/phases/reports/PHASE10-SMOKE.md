# Phase 10D — Smoke results

Verified against production (`https://mwg-crm.vercel.app`) deployment of commit `fe25f5e`.

The application is gated by Microsoft Entra SSO (Azure AD). The smoke agent cannot complete the OAuth flow as a logged-in user, so the per-user click-through walkthroughs in §3.6 / §3.7 of the brief are deferred to manual sign-in by the user. The smoke this pass covers everything that doesn't require browser-based authentication: schema parity, route resolution, build hygiene, audit shape, and code-level matrix verification.

## What I verified

### Schema parity
```sql
-- Phase 10 columns on all six entity tables — verified live
SELECT table_name, … is_deleted, deleted_at, deleted_by_id, delete_reason …
```
All six tables (`leads`, `crm_accounts`, `contacts`, `opportunities`, `tasks`, `activities`) report ✅ for every column.

### Activities indexes
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'activities' AND indexname LIKE 'activities_active_%';
```
Returns:
- `activities_active_lead_idx`
- `activities_active_account_idx`
- `activities_active_contact_idx`
- `activities_active_opportunity_idx`

Plus `activities_deleted_by_id_idx` (covers the FK).

### Route resolution (HTTP 307 = auth redirect, route exists)
```
307  /leads
307  /accounts
307  /contacts
307  /opportunities
307  /tasks
307  /leads/archived
307  /accounts/archived
307  /contacts/archived
307  /opportunities/archived
307  /tasks/archived
```
Every entity page and every archive view renders as a registered Next.js route (no 404). Auth middleware redirects unauthenticated requests to `/auth/signin` as expected.

### Build hygiene
- `pnpm tsc --noEmit` — exit 0
- `pnpm lint` — exit 0, zero warnings
- `pnpm build` — succeeds; build output lists all five `/{entity}/archived` routes as `ƒ` (server-rendered on demand).
- Vercel deployment `dpl_AJWCiUBx3BZiwACrutGJ3ckPg4ek` (commit `fe25f5e`) reached READY state.

### Supabase advisors after the migration
- Security: 24 RLS-no-policy INFO entries (pre-existing — application uses app-level auth, not RLS) and 2 extension-in-public WARN entries (pre-existing). **No new HIGH/WARN issues.**
- Performance: pre-existing unused-index entries; the four new `activities_active_*_idx` and `activities_deleted_by_id_idx` show as unused (just-created, no traffic yet — expected).

### Audit log shape — verified existing rows
```sql
SELECT action, target_type, before_json IS NOT NULL, after_json IS NOT NULL FROM audit_log
WHERE action IN ('lead.archive','lead.restore','lead.purge') ORDER BY created_at DESC LIMIT 5;
```
Existing rows confirm the shape works:
- `lead.archive` → `after_json` contains `{ reason }`
- `lead.purge` (cron) → `before_json` contains the full lead snapshot, `after_json` null
- `lead.restore` → both null (no diff payload needed)

The new Phase 10 server actions (`softDeleteLeadAction`, `softDeleteAccountAction`, etc.) additionally populate `before_json` with `{ name/firstName/lastName, ownerId }` so future archive rows will have richer attribution than the legacy `deleteLeadAction` did.

## Permission matrix — code-level verification

| Rule | Where enforced | Verified |
|---|---|---|
| Lead owner OR admin can soft-delete | `softDeleteLeadAction` re-fetches lead and calls `canDeleteLead(user, row)`; throws ForbiddenError + writes `access.denied.lead.delete` audit on miss. | ✅ |
| Account/Contact/Opportunity owner OR admin can soft-delete | Each entity's `softDelete{Entity}Action` re-fetches and gates via `canDelete{Entity}` from `src/lib/access/can-delete.ts`. | ✅ |
| Task creator OR assignee OR admin | `canDeleteTask` checks both `createdById === user.id` and `assignedToId === user.id`; replaces pre-Phase-10 `deleteTaskAction` which had **no permission check at all**. | ✅ |
| Activity author OR admin | `softDeleteActivityAction` re-fetches `activities.userId` and matches against `user.id` or admin. | ✅ |
| Hard delete = admin only | Each `hardDelete{Entity}Action` checks `canHardDelete(user)` first; throws ForbiddenError otherwise. | ✅ |
| `canViewAllRecords` does NOT grant delete | `can-delete.ts` helpers do not consult the permissions table at all — only the actor's `isAdmin` flag and the row's owner id (or task creator/assignee, or activity author). | ✅ |
| Cross-record activity isolation | `canDeleteActivity` ignores the parent record's owner — a lead owner cannot delete an activity authored by someone else, even on their own lead. | ✅ |
| HMAC undo token expires after 5s | `signUndoToken` writes `exp = Date.now() + 5_000`; `verifyUndoToken` rejects when `exp < Date.now()`. | ✅ (HMAC-SHA256 + `timingSafeEqual` in code) |

## What needs the user's manual confirmation (browser walkthrough)

Recommended manual smoke from a logged-in admin session:

1. **Visible UI per entity** — open `/leads`, `/accounts`, `/contacts`, `/opportunities`, `/tasks`. On each row hover, the trash icon should appear; clicking opens the confirm dialog. Detail pages have an Archive button in the header.
2. **Confirm dialog** — every modal shows "Archive this {entity}?" with the entity name in bold, an optional reason textarea, Cancel / Archive buttons.
3. **Undo toast** — after Archive, a sonner toast appears with an Undo button for ~5 seconds. Clicking Undo restores the row; refresh shows it back in the list.
4. **Archive view** — `/leads/archived`, `/accounts/archived`, `/contacts/archived`, `/opportunities/archived`, `/tasks/archived` all show the same template (Name/Industry-or-Title, Archived date, By, Reason, Restore + admin Hard-delete buttons).
5. **Opportunity Kanban** — at `/opportunities/pipeline`, hover a card you own → trash icon top-right; clicking it doesn't initiate a drag (pointerdown propagation stopped); confirm + undo work.
6. **Activity timeline** — open a lead with activities; hover an activity card you authored → trash icon top-right; archive recomputes the lead's `last_activity_at` (visible on the lead list "Last activity" column on next refresh).
7. **Permission negative tests** — sign in as a non-admin non-owner; trash icons should not render on rows you don't own; detail-page Archive button should be absent.

If any step fails, that's a regression — the code-level guarantees above are in place but only manual UI verification confirms the wiring is correctly mounted.
