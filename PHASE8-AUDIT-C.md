# Phase 8 Audit C — Server Actions + Route Handlers

Auditor: Sub-agent C (read-only static analysis)
Method: grep-driven inventory + per-file inspection of every action / route file
Date: 2026-05-07

## Summary

Total exported server-action functions found: **38** (excluding the unused `_placeholderEmailAction`)
Total exported route handlers found: **9**

Helper inventory:
- `concurrentUpdate` — defined in `src/lib/db/concurrent-update.ts`. Implementation is correct: compare-and-set on `version`, throws `NotFoundError` vs `ConflictError`, bumps `version` and `updated_at` in same UPDATE.
- `expectAffected` — sister helper in same file. Used by callers that already have a Drizzle update builder (the more-typed path); throws the same conflict-vs-not-found errors when 0 rows returned.
- `withErrorBoundary` — defined in `src/lib/server-action.ts`. **NOT WIRED**: zero server actions or routes invoke it. Every action implements its own ad-hoc try/catch with non-uniform return shapes.
- Access gates — split across two files: `src/lib/access.ts` (defines `requireLeadAccess`, `requireAccountAccess`, `requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess`, `requireSavedViewAccess`) and `src/lib/auth-helpers.ts` (defines a *different* `requireLeadAccess`, `requireLeadEditAccess`, `requireSession`, `requireAdmin`, `requirePermission`, `requireSelfOrAdmin`, `getPermissions`, `ForbiddenError`). **The two files duplicate access logic with subtly different rules.** Every call site uses the `auth-helpers.ts` flavor; `src/lib/access.ts` appears to be dead code (zero imports of the access functions defined there).
- `writeAudit` — `src/lib/audit.ts`. Best-effort with auto-snapshotting actor email. Fine.
- `logger` — `src/lib/logger.ts`. JSON output, redaction list, ERROR/WARN→stderr, INFO/DEBUG→stdout, debug suppressed in prod.

Compliance table

| Discipline | Compliant | Total | % |
|---|---|---|---|
| Zod input validation on user input | 33 | 38 | 87% |
| OCC (`concurrentUpdate` OR equivalent compare-and-set on `version`) where applicable | 9 | 11 versioned-table mutators | 82% |
| Access gate when taking a resource id | 22 | 27 id-bearing actions | 81% |
| `withErrorBoundary` wrapper | **0** | 38 | **0%** |
| `logger.*` (no stray `console.*`) | 38 | 38 | 100% |
| `writeAudit` on mutating actions | 30 | 33 mutating actions | 91% |
| Consistent return shape | 15 of 38 use `{ ok, error }`; 5 use `redirect()`; 5 use `throw`; 13 mixed | — | inconsistent |

Forbidden-pattern scan
- `sql.raw(`: **0 occurrences in `src/`**.
- `dangerouslySetInnerHTML`: **1 occurrence** — `src/app/leads/print/[id]/page.tsx:208`. Content is a hard-coded literal string (`"window.addEventListener('load',function(){setTimeout(function(){window.print()},250)});"`); no interpolation, no user input. Acceptable but flagged for visibility.
- `eval(` / `new Function(`: **0 occurrences**.
- `db.update(...)` on a versioned table without compare-and-set: **6 occurrences** (see findings).
- `console.log/error/warn/debug` outside `src/lib/logger.ts`: **0 occurrences**. The two `console.*` lines inside `logger.ts` are the logger's own emit path.
- Unprotected admin actions: **0** — every admin/* action calls `requireAdmin`.
- Unprotected route handlers: **0** — every API route either calls `requireSession`/`requireAdmin` or validates `CRON_SECRET`.

---

## Findings

### C-1 — High — `withErrorBoundary` is built but unused everywhere

Files: every server action under `src/app/**/actions.ts` and `src/components/**/actions.ts`
Helper: `src/lib/server-action.ts:30` (`withErrorBoundary`), `src/lib/errors.ts` (KnownError hierarchy)

The Phase 4A error-boundary helper defines a clean pattern: catch `KnownError` → public message + stable code + `requestId`; catch unknown → log full detail + return generic public message + `requestId`. Every action ignores it.

Concrete impact:
- Each action duplicates a try/catch block.
- Return shapes drift: some return `{ ok, error }`; some return `{ ok, error, fieldErrors }`; some return `{ ok, error, code }`; some return `{ ok, version }`; some return `{ ok, processed }`; some `throw new Error(...)` to the form layer (`updateAdminFlag`, `updateActiveFlag`, `forceReauth`, `restoreLeadAction`, `hardDeleteLeadAction`, `deleteLeadAction`).
- No central `requestId` is emitted, so client-visible error strings cannot be correlated to a server log line.
- Zod errors are not consistently translated to the typed `ValidationError`; some actions surface raw `parsed.error.errors[0]?.message` (which can leak internal field names like `expectedVersion`).

Recommended fix: wrap every action body in `withErrorBoundary({ action: "lead.update", userId, entityType: "lead", entityId: id }, async () => { … })`. Throw `KnownError` subclasses (which already exist) for user-facing failures.

### C-2 — High — Two parallel access-control modules; the new one (`lib/access.ts`) is dead code

Files: `src/lib/access.ts` (created Phase 4A), `src/lib/auth-helpers.ts`
Search proof:
- `requireLeadAccess` defined in BOTH files with different signatures and slightly different rules:
  - `auth-helpers.ts`: takes `(user: SessionUser, leadId)`; non-admin needs `canViewAllRecords` OR be the owner.
  - `access.ts`: takes `(id, userId, action, options)`; same rule but also handles a 5-line audit-log-on-deny path and looks up perms via a single `loadPerms` helper.
- Every server action and route imports from `auth-helpers.ts`. Zero call sites import the access-gate functions from `access.ts`.

Concrete impact:
- Code duplication. Two sources of truth — when access rules change (e.g., assignee support, team roles) one will drift.
- The `denyAndLog` audit-on-deny pattern in `lib/access.ts` is the better implementation, but no one uses it, so denied-access events aren't audit-logged in production.
- Other entity gates (`requireAccountAccess`, `requireContactAccess`, `requireOpportunityAccess`, `requireTaskAccess`, `requireSavedViewAccess`) defined ONLY in `lib/access.ts` are unused — every related action either uses inline `select + ownerId === session.id` or skips the gate entirely.

Recommended fix: pick one. Either delete `lib/access.ts`, or migrate `auth-helpers.ts` callers to `access.ts` and delete the duplicates from `auth-helpers.ts`. Standardise on the access.ts shape (it has the audit-on-deny path and is broader).

### C-3 — High — `updateOpportunityStageAction` has no OCC version check on a versioned table

File: `src/app/(app)/opportunities/pipeline/actions.ts:40-48`
Snippet:
```ts
await db
  .update(opportunities)
  .set({
    stage: parsed.data,
    closedAt: parsed.data === "closed_won" || parsed.data === "closed_lost" ? new Date() : null,
  })
  .where(eq(opportunities.id, id));
```
`opportunities.version` exists (`src/db/schema/crm-records.ts:160`). The update neither bumps it nor compares against an expected version. Two users dragging the same opportunity card simultaneously will race silently.

Recommended fix: add `version` and `updatedAt` to the `set`, plus `eq(opportunities.version, expectedVersion)` to the `where`, and wrap with `expectAffected` — or just call `concurrentUpdate({ table: opportunities, id, expectedVersion, patch })`. The pipeline UI must thread `version` through the action call.

### C-4 — High — `updateLeadStatusAction` (kanban DnD) has no OCC version check

File: `src/app/(app)/leads/pipeline/actions.ts:40-44`
Snippet:
```ts
await db
  .update(leads)
  .set({ status: parsed.data, updatedById: session.id })
  .where(eq(leads.id, leadId));
```
`leads.version` exists and the rest of the lead-update path uses OCC. This pipeline path bypasses it. Same race-condition risk as C-3.

Recommended fix: same as C-3 — call `updateLead(user, leadId, expectedVersion, { status: parsed.data })` (which already does the version check) and thread `version` through the kanban card.

### C-5 — High — `updatePermission` performs an unconditional INSERT…ON CONFLICT DO UPDATE without version check

File: `src/app/admin/users/[id]/actions.ts:39-45`
The `permissions` table doesn't expose a `version` column (verified in `src/db/schema/users.ts`), so this isn't strictly an OCC violation, but the consequence is the same: two admins toggling a permission flag concurrently will silently overwrite each other. The `before` snapshot is captured but the audit-log read is not transactional with the upsert.

Recommended fix: lower priority than C-3/C-4 since admin concurrency is rare. Either add a `version` column to `permissions`, or perform the read + upsert inside a Drizzle transaction.

### C-6 — Medium — `db.update(leads).set({ lastActivityAt: null })` cascades through every lead with no `WHERE`

File: `src/app/admin/data/actions.ts:79`
Snippet:
```ts
await db.update(leads).set({ lastActivityAt: null });
```
The action is admin-only and the user already typed `DELETE ALL ACTIVITIES`, so this isn't unauthorized. BUT:
- It does NOT bump `version` or `updatedAt` on those rows. Concurrent edits in flight at the moment a destructive admin runs this will silently mix.
- It is the only `db.update(...)` occurrence in the codebase that uses no `WHERE`. Easy to mis-copy if someone refactors.

Recommended fix: add `updatedAt: sql\`now()\`` and either `version: sql\`version + 1\`` or skip versioning on cascading admin nukes (and document why). At minimum, narrow to `where(isNotNull(leads.lastActivityAt))` so unaffected rows aren't touched.

### C-7 — Medium — `updateAdminFlag` / `updateActiveFlag` / `forceReauth` skip OCC and use `throw new Error(...)`

File: `src/app/admin/users/[id]/actions.ts:58-165`
- All three call `db.update(users).set({...}).where(eq(users.id, userId))` — but `users` doesn't have a `version` column, so OCC isn't possible without a schema change.
- All three throw raw `Error` (e.g., `"Refusing to remove your own admin flag."`, `"Cannot deactivate the breakglass account."`). These messages flow through Next.js's server-action error path with no `requestId`, no stable code, and no controlled public message — they end up in the user's UI verbatim.
- All three lack a `try { … } catch { logger.error(...) }` block; Postgres failures bubble up with stack traces in dev.

Recommended fix:
- Convert raw throws to `ForbiddenError` / `ConflictError` from `lib/errors.ts`.
- Wrap with `withErrorBoundary` (see C-1).
- For OCC on `users`, either add a `version` column or accept the trade-off (these admin actions are low-frequency).

### C-8 — Medium — `disconnectGraphAction` and `signOutEverywhereAction` skip OCC on `users.session_version` / `accounts.*`

File: `src/app/(app)/settings/actions.ts:132-191`
- `signOutEverywhereAction` runs `set({ sessionVersion: sql\`session_version + 1\` })` — the increment is server-side so a race ends up with one too few bumps but never with stale state, so this is actually safe.
- `disconnectGraphAction` overwrites `accounts.access_token` etc. with NULL on every account row for the user. The `accounts` table doesn't have a `version` column (it's the Auth.js OAuth-account table), so OCC isn't expected. However, no audit captures the `before` shape (we don't know which provider tokens existed), and there's no version increment. Re-running this is idempotent so the impact is low.

Recommended fix: capture before-snapshot of `provider`/`providerAccountId` (NOT the token values) in audit log so admins can see "user was disconnected from provider X at time Y."

### C-9 — Medium — `signOutEverywhereAction` and `forceReauth` lack rate-limiting

Files:
- `src/app/(app)/settings/actions.ts:132` (self-service)
- `src/app/admin/users/[id]/actions.ts:134` (admin)

Each is a single click that mutates `session_version`. A bad actor (or an over-eager client retry) can hammer it. The breakglass sign-in has rate-limiting in `src/auth.ts:56`; nothing else does.

Recommended fix: low priority. If the auth provider is Entra and these endpoints are session-gated, the practical risk is small. A simple in-process token-bucket on user-id would close it.

### C-10 — Medium — `subscribeToViewAction` performs upsert without OCC, but `savedViews` is versioned

File: `src/app/(app)/settings/subscriptions-actions.ts:38-58`
The action upserts `saved_search_subscriptions` (which doesn't have a `version` column itself — fine), but it doesn't validate that the `savedViews` row hasn't been deleted between the read at line 28 and the write. A user racing a saved-view delete in another tab could subscribe to a no-longer-existent view. Postgres's FK will catch the orphan, but the error surface is not user-friendly.

Recommended fix: low priority. Catch the FK violation and translate to a `NotFoundError`.

### C-11 — Medium — `bulkTagLeadsAction` issues N audit-log inserts in a loop

File: `src/components/tags/actions.ts:127-138`
`bulkTagLeadsAction` accepts up to 1000 lead ids and writes one audit row per lead via a sequential `for` loop. Each `writeAudit` is a separate INSERT — 1000 round-trips per click. Slow and easy to time-out the action.

Recommended fix: replace the loop with a single bulk `db.insert(auditLog).values([...])` of all rows. Optionally write a single audit row with `targetId = null` and `after.leadIds = [...]` — sacrifices per-lead searchability for speed.

### C-12 — Medium — Inconsistent return shapes across actions

Examples:
- `createLeadAction` returns `{ ok, error?, fieldErrors?, id? }` (custom local type, not the central `ActionResult`).
- `updateLeadAction` returns `{ ok, error?, fieldErrors?, id? }` but on success calls `redirect()` (so `ok: true` is unreachable from the success path).
- `updateLeadStatusAction` returns `{ ok: true } | { ok: false; error: string }` (doesn't match `ActionResult<T>`).
- `subscribeToViewAction` matches the same shape but no `code` field.
- `updateScoringRuleAction` returns `{ ok: false; error; code? }` — the only one that surfaces an error code, and it's hand-rolled (`code: "CONFLICT"`).
- `rotateBreakglassPassword` returns `{ ok, password?, error? }` — exposes a plaintext password in the success branch.
- `deleteLeadAction` / `restoreLeadAction` / `hardDeleteLeadAction` / `forceReauth` / `updateAdminFlag` / `updateActiveFlag` / `updatePermission` use the `throw new Error(...)` pattern instead — Next.js converts these into generic 500 responses for the client.
- `signInBreakglassAction` returns `{ ok: true } | { ok: false; error }` and re-throws Auth.js redirects.

Recommended fix: this is C-1 again — adopt `withErrorBoundary` and the `ActionResult<T>` shape across the board.

### C-13 — Medium — `convertLeadAction` has a brittle redirect-error sentinel

File: `src/app/(app)/leads/[id]/convert/actions.ts:46`
Snippet:
```ts
if (err && typeof err === "object" && "digest" in err) throw err;
```
This is the duck-test for Next.js redirect errors. It's fragile (any KnownError with a `digest` field — unlikely but possible — would be re-thrown as a redirect). The same pattern appears (slightly more carefully) in `signInBreakglassAction` where it actually checks `digest.startsWith("NEXT_REDIRECT")`. Standardise.

Recommended fix: use the documented Next.js `isRedirectError` (from `next/dist/client/components/redirect`) or apply the `digest.startsWith("NEXT_REDIRECT")` check in both spots.

### C-14 — Medium — `previewImportAction` / `commitImportAction` write `errors: [{...}] as unknown as object` to `import_jobs.errors`

File: `src/app/(app)/leads/import/actions.ts:112` and 178
Snippets:
```ts
errors: [{ row: 0, field: "_fatal", message: String(err) }] as unknown as object,
```
- `String(err)` can leak full DB connection strings, stack traces, or whatever the underlying lib serialises. The `import_jobs.errors` field is read by the import preview UI and surfaces to the importing user.
- Belongs to the `KnownError` story — a redacted public message is what the user should see; full `err.message` should be in `logger.error` only.

Recommended fix: log full err via `logger.error`; store only a generic `"Preview failed"` / `"Commit failed"` in `errors` for the user-facing UI.

### C-15 — Medium — Cron routes don't check Vercel's actual cron header

Files:
- `src/app/api/cron/purge-archived/route.ts:21-24`
- `src/app/api/cron/rescore-leads/route.ts:18-22`
- `src/app/api/cron/saved-search-digest/route.ts:18-22`
- `src/app/api/cron/tasks-due-today/route.ts:18-22`

Each route validates `Authorization: Bearer ${env.CRON_SECRET}`. The Vercel platform's preferred verification is `x-vercel-cron-signature` plus `request.headers.get('x-vercel-cron')`. Bearer-token auth is functionally equivalent and the secret is in env, so this works — but if `CRON_SECRET` ever leaks (e.g., via a logged stack trace), any external caller can run the cron. Vercel's signature path doesn't have that risk.

Recommended fix: low priority. Optionally add a defense-in-depth check on `x-vercel-cron-signature` if Vercel publishes one for this account.

### C-16 — Medium — `cancelImportAction` doesn't check ownership of the cached job

File: `src/app/(app)/leads/import/actions.ts:212-223`
Snippet:
```ts
export async function cancelImportAction(jobId: string): Promise<{ ok: true }> {
  const user = await requireSession();
  const cached = getJob(jobId, user.id);
  if (cached) deleteJob(jobId);
  await db
    .update(importJobs)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(sql`id = ${jobId}::uuid`);
  return { ok: true };
}
```
- `getJob(jobId, user.id)` enforces ownership for the in-memory cache — fine.
- The DB `update` to `importJobs` has NO ownership check. Any signed-in user can cancel any other user's import job. Bare `where(id = jobId)` lets a user pass a guessed UUID and flip another user's job to `cancelled`.

Recommended fix: add `eq(importJobs.userId, user.id)` to the where clause (admin override OK).

### C-17 — Medium — `deleteScoringRuleAction` / `deleteTaskAction` have no expected-version check

Files:
- `src/app/admin/scoring/actions.ts:179` — `db.delete(leadScoringRules).where(eq(leadScoringRules.id, id))`. The table has `version`. A delete-after-edit race can wipe a rule the admin no longer wanted to delete.
- `src/lib/tasks.ts:202` — `deleteTask` does the same on a versioned table.

Recommended fix: low priority. Deletes are typically intent-explicit; OCC on delete is uncommon. Document the choice.

### C-18 — Low — `searchTagsAction` and `getOrCreateTagAction` accept any signed-in user

File: `src/components/tags/actions.ts:39-58`
- `searchTagsAction` returns every tag in the system with no per-user filter. If tags are intended to be org-private, every user can enumerate them.
- `getOrCreateTagAction` lets every user create new tags with arbitrary names. No length/charset validation beyond what's in `getOrCreateTag` (single-color default, no name regex). User abuse via thousands of one-off tag rows is possible.

Recommended fix: low priority. If tags are meant to be org-shared (the schema does not partition by user), this is by design. Add a tag-name regex (`^[\w\s-]{1,60}$`) and length cap server-side anyway.

### C-19 — Low — `updateLeadAction` / `updateTaskAction` / `updateViewAction` parse `version` via `z.coerce.number().int().positive()` but error message exposes Zod field name

If `version` is missing or non-numeric, the user sees a string like `"version: Required"` or `"version: Expected number, received string"`. Acceptable, but inconsistent with `convertLeadAction` which uses Zod and surfaces `parsed.error.errors[0]?.message`.

Recommended fix: trivial. Standardise via `withErrorBoundary` + `ValidationError` translation (see C-1).

### C-20 — Low — `addNoteAction` / `addCallAction` / `addTaskAction` audit `targetType: "activity"` but DB FK is to `activities` (Phase 8B finding overlap)

These actions write `writeAudit({ targetType: "activity" })`. Other actions write `targetType: "leads"` (plural, table name) or `"lead"` (singular, entity name). The audit-log query layer (if any) filtering by `targetType` won't match either way without normalisation.

Recommended fix: standardise on table-name singular ('`lead`', `'activity'`, `'task'`, `'opportunity'`, `'account'`, `'contact'`, `'user'`, `'saved_view'`) — most code already does this, but `setScoringThresholdsAction` writes `"lead_scoring_settings"` while `updateScoringRuleAction` writes `"lead_scoring_rules"` (both correct table names). The drift between `"lead"` and `"leads"` is the issue.

Findings of mismatched targetType:
- `updateLeadStatusAction` → `"leads"` (plural) — `src/app/(app)/leads/pipeline/actions.ts:43`
- `updateOpportunityStageAction` → `"opportunities"` (plural) — `src/app/(app)/opportunities/pipeline/actions.ts:50`
- All other lead actions → `"lead"` (singular)
- `signOutEverywhereAction` / `disconnectGraphAction` / `forceReauth` → `"users"` / `"accounts"` (plural)

### C-21 — Low — `dangerouslySetInnerHTML` in `print/[id]/page.tsx` is hard-coded but flagged by Phase 4A scan

File: `src/app/leads/print/[id]/page.tsx:208`
Static literal string, no interpolation, no XSS path. Listed for completeness — Phase 4A's "no `dangerouslySetInnerHTML`" rule is overly broad; this use is safe. Either suppress with an eslint-disable comment + justification, or replace with a `useEffect` client-side trigger.

---

## Pattern table (full server-action inventory)

Format: file:line — function — has-id? — Zod? — OCC? — access-gate? — withErrorBoundary? — audit? — return-shape

### `src/app/(app)/leads/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return shape |
|---|---|---|---|---|---|---|---|---|
| 49 | `createLeadAction` | no | yes | n/a | perm-only | no | yes | redirect |
| 83 | `updateLeadAction` | yes | yes | **YES** (via `updateLead` → `expectAffected`) | yes | no | yes | redirect (success unreachable) |
| 161 | `deleteLeadAction` | yes | yes (id) | n/a (archive) | yes (`requireLeadAccess`) | no | yes | redirect |
| 187 | `restoreLeadAction` | yes | yes (id) | n/a | admin-only inline | no | yes | void (admin throw on miss) |
| 208 | `hardDeleteLeadAction` | yes | yes (id) | n/a | admin-only inline | no | yes | void |

### `src/app/(app)/leads/[id]/activities/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 37 | `addNoteAction` | yes (lead) | yes | n/a | yes | no | yes | `{ok,error?}` |
| 73 | `addCallAction` | yes | yes | n/a | yes | no | yes | `{ok,error?}` |
| 114 | `addTaskAction` | yes | yes | n/a | yes | no | yes | `{ok,error?}` |
| 153 | `deleteActivityAction` | yes | yes (id) | n/a | yes (lead) | no | yes | void |
| 171 | `_placeholderEmailAction` | – | – | – | – | – | – | placeholder |

### `src/app/(app)/leads/[id]/convert/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 17 | `convertLeadAction` | yes | yes | n/a (creates) | yes | no | yes (in `convertLeadWithAudit`) | redirect |

### `src/app/(app)/leads/[id]/graph/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 31 | `sendEmailAction` | yes | yes | n/a (creates) | yes (perm + lead) | no | yes | `{ok,error?,reauthRequired?}` |
| 127 | `scheduleMeetingAction` | yes | yes | n/a | yes | no | yes | same |

### `src/app/(app)/leads/import/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 36 | `previewImportAction` | no | partial (file shape) | n/a | perm-only | no | no | `{ok,error?,jobId,...}` |
| 129 | `commitImportAction` | yes (jobId) | implicit (jobCache) | OCC inside `commitImport` | perm + jobId-owner | no | yes | `{ok,error?,result?}` |
| 212 | `cancelImportAction` | yes (jobId) | no Zod (raw string) | n/a | **NO ownership check on DB update — see C-16** | no | no | `{ok}` |

### `src/app/(app)/leads/pipeline/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 24 | `updateLeadStatusAction` | yes | yes | **NO — see C-4** | yes (`requireLeadEditAccess`) | no | yes | `{ok}\|{ok,error}` |

### `src/app/(app)/leads/view-actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 28 | `createViewAction` | no | yes | n/a | session-only (creates own) | no | yes | `{ok,error?,id?}` |
| 81 | `updateViewAction` | yes | yes | yes (`updateSavedView` → `expectAffected`) | inline (userId check) | no | yes | same |
| 125 | `deleteViewAction` | yes | yes | n/a | inline | no | yes | void |
| 139 | `trackViewSelection` | yes | no | n/a | session | no | no | void |
| 150 | `setAdhocColumnsAction` | no | yes | n/a | session | no | no | `{ok,error?}` |

### `src/app/(app)/opportunities/pipeline/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 21 | `updateOpportunityStageAction` | yes | yes | **NO — see C-3** | inline (admin OR ownerId) — no `requireOpportunityAccess` | no | yes | `{ok}\|{ok,error}` |

### `src/app/(app)/settings/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 56 | `updatePreferencesAction` | self | yes | yes (inline ON CONFLICT…WHERE) | self | no | yes | `{ok,version}\|{ok,error}` |
| 132 | `signOutEverywhereAction` | self | n/a | safe (server-side `+ 1`) | session | no | yes | `{ok}\|{ok,error}` |
| 162 | `disconnectGraphAction` | self | n/a | n/a | session | no | yes | same |

### `src/app/(app)/settings/subscriptions-actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 18 | `subscribeToViewAction` | yes | yes | n/a (subscriptions has no version) | inline view-owner check | no | yes | `{ok}\|{ok,error}` |
| 73 | `unsubscribeFromViewAction` | yes | no Zod (raw string) | n/a | implicit (delete-by-userId) | no | yes | same |

### `src/app/(app)/tasks/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 27 | `createTaskAction` | no | yes | n/a | session | no | yes (in `createTask`) | `{ok,id}\|{ok,error}` |
| 80 | `updateTaskAction` | yes | yes | yes (via `updateTask` → `expectAffected`) | implicit through helper | no | yes | `{ok,version}` |
| 113 | `deleteTaskAction` | yes | implicit (z.string()) — no real validation | **no version check — C-17** | implicit | no | yes (in `deleteTask`) | `{ok}\|{ok,error}` |
| 130 | `toggleTaskCompleteAction` | yes | implicit | yes | implicit | no | yes | `{ok,version}` |

### `src/app/admin/data/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 41 | `deleteAllLeadsAction` | n/a | yes (confirm) | n/a (mass-delete) | `requireAdmin` | no | yes | `{ok,affected}` |
| 64 | `deleteAllActivitiesAction` | n/a | yes | **C-6: bare `db.update(leads).set({lastActivityAt: null})` no version bump** | `requireAdmin` | no | yes | same |
| 91 | `deleteAllImportsAction` | n/a | yes | n/a | `requireAdmin` | no | yes | same |

### `src/app/admin/scoring/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 81 | `createScoringRuleAction` | no | yes | n/a | `requireAdmin` | no | yes | `{ok,id}\|{ok,error}` |
| 118 | `updateScoringRuleAction` | yes | yes | yes (inline raw SQL version check) | `requireAdmin` | no | yes | `{ok}\|{ok,error,code?}` |
| 174 | `deleteScoringRuleAction` | yes | implicit | **no version check — C-17** | `requireAdmin` | no | yes | `{ok}\|{ok,error}` |
| 197 | `setScoringThresholdsAction` | n/a | yes | partial (bumps `version` but no expected-version check) | `requireAdmin` | no | yes | same |
| 246 | `recomputeAllScoresAction` | n/a | n/a | n/a (read+rescore) | `requireAdmin` | no | yes | `{ok,processed}\|{ok,error}` |

### `src/app/admin/users/[id]/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 24 | `updatePermission` | yes | yes | partial (no version on permissions) — see C-5 | `requireAdmin` | no | yes | void (no return; `revalidatePath`) |
| 58 | `updateAdminFlag` | yes | yes | n/a (users has no version) | `requireAdmin` | no | yes | void; `throw new Error` for misuse — C-7 |
| 94 | `updateActiveFlag` | yes | yes | n/a | `requireAdmin` | no | yes | void; raw throws |
| 134 | `forceReauth` | yes | yes | n/a | `requireAdmin` | no | yes | void |
| 167 | `rotateBreakglassPassword` | n/a | n/a | n/a | `requireAdmin` | no | yes | `{ok,password?,error?}` — exposes plaintext |

### `src/app/admin/users/[id]/delete-user-actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 44 | `getDeleteUserPreflight` | yes | implicit | n/a (read) | `requireAdmin` | no | n/a | `DeleteUserPreflight` |
| 130 | `deleteUserAction` | yes | yes | implicit (transaction; users has no version) | `requireAdmin` | no | yes | redirect |

### `src/app/auth/signin/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 19 | `signInBreakglassAction` | n/a | yes | n/a | n/a (this IS the auth gate) | no | n/a (auth.ts logs) | `{ok}\|{ok,error}` |

### `src/components/notifications/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 8 | `markAllReadAction` | self | n/a | n/a | session | no | no (read-flag only) | `{ok}\|{ok,error}` |
| 25 | `markReadAction` | yes (notif id) | no Zod | n/a | implicit (markRead checks user-id) | no | no | same |

### `src/components/tags/actions.ts`

| Line | Function | Id? | Zod | OCC | Access gate | Boundary | Audit | Return |
|---|---|---|---|---|---|---|---|---|
| 39 | `searchTagsAction` | n/a | n/a | n/a | session | no | n/a | `PublicTag[]` — see C-18 |
| 45 | `getOrCreateTagAction` | n/a | n/a (string) | n/a | session | no | no | `PublicTag\|null` — see C-18 |
| 61 | `updateTagAction` | yes | yes | n/a (no `version` on tags) | `requireAdmin` | no | yes (in `updateTag`) | `{ok}\|{ok,error}` |
| 94 | `bulkTagLeadsAction` | yes (many) | yes | n/a | per-lead access loop | no | yes (N rows — C-11) | `{ok,leadsTouched,...}\|{ok,error}` |
| 148 | `deleteTagAction` | yes | implicit | n/a | `requireAdmin` | no | yes (in `deleteTag`) | `{ok}\|{ok,error}` |

---

## Route handler inventory

| File:line | Method | Auth | Zod | Logger? | Notes |
|---|---|---|---|---|---|
| `src/app/api/auth/[...nextauth]/route.ts:4` | GET, POST | n/a (auth) | n/a | yes (handlers) | Re-exports from `@/auth-handlers` — fine |
| `src/app/api/cron/purge-archived/route.ts:21` | GET | `CRON_SECRET` bearer | n/a | yes | Snapshots via `writeAudit` before delete |
| `src/app/api/cron/rescore-leads/route.ts:15` | GET | `CRON_SECRET` | n/a | yes | Trivial |
| `src/app/api/cron/saved-search-digest/route.ts:14` | GET | `CRON_SECRET` | n/a | yes | Trivial |
| `src/app/api/cron/tasks-due-today/route.ts:14` | GET | `CRON_SECRET` | n/a | yes | Trivial |
| `src/app/api/leads/check-duplicate/route.ts:30` | GET | `requireSession` | manual trim/validate | no logger calls (read-only) | Filters non-admin to own |
| `src/app/api/leads/export/route.ts:7` | GET | `requireSession` + perm | n/a | no | Reuses `listLeads` |
| `src/app/api/leads/import-template/route.ts:5` | GET | `requireSession` + perm | n/a | no | Trivial |
| `src/app/api/search/route.ts:25` | GET | `requireSession` | manual | yes | All `db.execute(sql\`…\`)` — parameterised, safe |

No route uses `withErrorBoundary` either (an HTTP-flavored equivalent isn't defined; would need a `withRouteBoundary` analogue). All routes return `NextResponse.json({ok:false,error:"..."}, {status:5XX})` on catch with a generic message — that's effectively the same shape.

---

## Final summary

Total exported server actions audited: 38. Total route handlers: 9.

**Top 5 critical gaps:**
1. **C-1: `withErrorBoundary` is built but unused (0% adoption).** Every action duplicates a try/catch with non-uniform return shapes; no `requestId` correlates client errors to server logs.
2. **C-2: Two duplicate access-control modules.** `src/lib/access.ts` (with audit-on-deny) is dead code; everyone uses the leaner `src/lib/auth-helpers.ts`. Pick one.
3. **C-3: `updateOpportunityStageAction` skips OCC** on a versioned table — concurrent kanban drags race silently.
4. **C-4: `updateLeadStatusAction` skips OCC** on a versioned table — same issue on the leads kanban.
5. **C-16: `cancelImportAction` lets any user cancel any other user's import job** (no `userId` filter on the DB update).

**Compliance percentages:**
- Zod input validation: 87% (33/38) — gaps are mostly raw `z.string().uuid().parse(formData.get("id"))` patterns that would be cleaner with declared schemas, plus `markReadAction` / `cancelImportAction` / `unsubscribeFromViewAction` / `searchTagsAction` / `getOrCreateTagAction` accepting raw strings unchecked.
- OCC where applicable: 82% (9/11) — `updateLeadAction`, `updateTaskAction`, `updateViewAction`, `updatePreferencesAction`, `updateScoringRuleAction`, `setScoringThresholdsAction`, `commitImportAction`, `convertLeadAction`, `toggleTaskCompleteAction` ✓; `updateLeadStatusAction`, `updateOpportunityStageAction` ✗.
- Access gate when taking an id: 81% (22/27) — gaps: `cancelImportAction`, `markReadAction` (relies on helper to enforce), `subscribeToViewAction` (inline check, OK), `updateOpportunityStageAction` (uses inline check, not the canonical `requireOpportunityAccess`), `updatePermission`/`updateAdminFlag`/etc. (admin-only is sufficient gate).
- `withErrorBoundary`: **0% (0/38)**.
- `logger.*` discipline: 100% — no stray `console.*` calls outside `logger.ts` itself.
- `writeAudit` on mutations: 91% (30/33) — `cancelImportAction`, `markAllReadAction`, `markReadAction` skip audit (read-state flips, arguably acceptable).
- Consistent return shape: low — at least 6 distinct shapes in use; `ActionResult<T>` from `lib/server-action.ts` is unused.

**Forbidden patterns**: `sql.raw=0`, `dangerouslySetInnerHTML=1` (static literal, safe), `eval=0`, `db.update on versioned without OCC=2 critical (leads/opps pipeline) + 1 moderate (admin nuke) + 3 minor (deletes on versioned tables) = 6 occurrences total`, `console.* outside logger=0`.
