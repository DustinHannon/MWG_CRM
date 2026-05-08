# MWG CRM — Architecture

Living architecture doc. Updated each phase. Source of truth for "how does the app
fit together?" — the code is authoritative for current behaviour, but this is the
map you read first.

---

## 1. System diagram (text)

```
                          (browser)
                              │
                  HTTPS + Auth.js JWT cookie
                              │
                       ┌──────▼─────────────────────────┐
                       │  Next.js 16 App Router         │
                       │  (Vercel Functions, Node 24)   │
                       │                                │
                       │  ┌────────────┐  ┌──────────┐  │
                       │  │ Middleware │→ │  Pages   │  │
                       │  │ (proxy.ts) │  │ + RSC    │  │
                       │  └─────┬──────┘  └────┬─────┘  │
                       │        │              │        │
                       │        │       ┌──────▼─────┐  │
                       │        │       │   Server   │  │
                       │        │       │  Actions   │  │
                       │        │       └──────┬─────┘  │
                       │        │              │        │
                       │  ┌─────▼──────────────▼─────┐  │
                       │  │ withErrorBoundary +      │  │
                       │  │ access gates + Zod       │  │
                       │  └─────┬──────────────┬─────┘  │
                       └────────┼──────────────┼────────┘
                                │              │
                  ┌─────────────▼──┐    ┌──────▼─────────┐
                  │ Drizzle / pg-  │    │ Microsoft Graph│
                  │ js (max:1)     │    │ /me/*, /sendMail│
                  └────────┬───────┘    └────────────────┘
                           │
                  ┌────────▼─────────┐
                  │ Supabase Postgres│
                  │ via supavisor    │
                  └────────┬─────────┘
                           │
              ┌────────────┴───────────────┐
              ▼                            ▼
  ┌──────────────────┐         ┌─────────────────────┐
  │ Vercel Blob      │         │ Vercel Cron         │
  │ (private store)  │         │ /api/cron/*         │
  │ avatars + attach │         └─────────────────────┘
  └──────────────────┘
```

## 2. Stack

| Layer        | Choice                              | Why |
|--------------|-------------------------------------|---|
| Runtime      | Vercel Functions, Node.js 24        | Fluid Compute; first-class Next.js support; Vercel knows Vercel |
| Framework    | Next.js 16 (App Router) + React 19  | Server Components let us skip a separate API tier |
| Styling      | Tailwind v4 + shadcn-style tokens   | Glass tokens documented in `globals.css`; dark default |
| ORM          | Drizzle 0.45 + postgres-js (max: 1) | Fits Supabase pooler; safer than 0.36 (CVE-2024) |
| Auth         | Auth.js v5 (`next-auth@beta`)       | JWT sessions; Entra OIDC + breakglass Credentials |
| DB           | Supabase Postgres                   | Managed, multi-region, role-based BYPASSRLS |
| Storage      | Vercel Blob (private)               | Avatars + attachments; signed downloads only |
| Email        | Microsoft Graph `/me/sendMail`      | Sends from the user's mailbox; no separate vendor |
| Crons        | Vercel Cron                         | `vercel.json` config; bearer-auth via `CRON_SECRET` |

## 3. Data model

Every public-schema table is RLS-enabled. The app's `mwg_crm_app` role has
`BYPASSRLS`, so the app sees everything; the PostgREST anon role sees nothing
(no policies = no rows). RLS-on without policies is the defense-in-depth pattern
documented in `mwg_crm_db_role` memory.

### Entities (Phase 1–4)

```
users (1) ──────< accounts        (Auth.js account row, manually managed)
users (1) ──────< sessions        (Auth.js — kept but JWT-only sessions)
users (1) ──────< permissions     (per-user feature flags; admin bypasses)
users (1) ──────< user_preferences (UI prefs, default landing, theme)

users (owner) <──── leads ──────< activities ──────< attachments
                          │ ─────< tasks
                          │ ─────< lead_tags >───── tags
                          ▼
                     (convert)
                          │
                  ┌───────┼────────┐
                  ▼       ▼        ▼
              crm_accounts contacts opportunities
                  ▲       ▲        │
                  └─ activities + tasks (any of the four parent types)

users (1) ──────< notifications
users (1) ──────< saved_views >─── saved_search_subscriptions
users (1) ──────< recent_views   (Cmd+K MRU)
users (1) ──────< import_jobs ──< leads (created_via='imported')

audit_log    (append-only; actor_id SET NULL on user delete +
              actor_email_snapshot preserves attribution forever)
```

### Cascade rules

`leads.owner_id` → `users` is **`ON DELETE RESTRICT`** — you cannot delete a
user who owns leads without explicitly reassigning them via the admin
delete-user flow.

History columns (`created_by_id`, `updated_by_id`, `assigned_to_id`,
`added_by_id`, `actor_id`, `source_lead_id`, `primary_contact_id`,
`import_job_id`) are **`ON DELETE SET NULL`** — the parent record stays, but
attribution becomes null + (where present) the email snapshot column.

Owned children — `activities`, `tasks`, `attachments`, `lead_tags`,
`notifications`, `saved_views`, `saved_search_subscriptions`, `recent_views`,
`user_preferences`, `permissions`, `sessions`, `accounts` — are
**`ON DELETE CASCADE`** through their owning parent.

The orphan scan (`scripts/orphan-scan.ts`) enumerates every parent/child pair
and expects zero rows. Phase 4A baseline: zero orphans across 16 relationships
(see `PHASE4-AUDIT.md`).

## 4. Auth flow

Two providers register on Auth.js v5:

1. **Microsoft Entra ID (OIDC)** — primary. The `signIn` callback enforces
   `ALLOWED_EMAIL_DOMAINS` against the OIDC `email`/`upn` claim, redirects to
   `/auth/signin?error=missing_token` if `access_token` is absent, and provisions
   the user (creating row if first-seen, otherwise refreshing display fields)
   inside the `jwt` callback.
2. **Credentials (breakglass)** — fallback. Singleton row enforced by partial
   unique index `users_one_breakglass`. Plaintext password printed to stderr
   *once* during cold-start bootstrap (retrieve via `vercel logs`). Rate-limited
   in-memory: 5 attempts/min/IP, plus a per-username throttle.

Sessions are **JWT** (no DB session lookup per request). Each token carries
`userId`, `isAdmin`, `email`, `displayName`, and `sessionVersion`. Every
request the JWT callback re-reads the user's `session_version`; mismatch
forces re-auth — this is how "Sign out everywhere" works (admin or self bumps
the column).

Open-redirect protection: `safeCallback()` in `src/app/auth/signin/actions.ts`
rejects any callback URL that isn't a same-origin relative path.

## 5. Cron stack

```
vercel.json:
  /api/cron/tasks-due-today    @ 0 14 * * *   (daily 14:00 UTC)
  /api/cron/saved-search-digest @ 0 14 * * *   (daily 14:00 UTC)
```

Phase 4 adds two more (configured in their respective sections of this doc as
they ship):
- `/api/cron/rescore-leads`     @ 0 9 * * *   (daily 09:00 UTC = 03:00 CT)
- `/api/cron/purge-archived`    @ 0 10 * * *  (daily 10:00 UTC = 04:00 CT)

All cron routes:
- Authenticate via `Authorization: Bearer ${CRON_SECRET}`. Anything else gets 401.
- Wrap their body in try/catch (Phase 4: `withErrorBoundary` where applicable)
  and return `{ ok, processed, errors }`.
- Are `runtime: 'nodejs'`, `dynamic: 'force-dynamic'`, `maxDuration: 300`.

## 6. External integrations

### Microsoft Graph
| Endpoint | Used by | Scope |
|---|---|---|
| `/me`            | `entra-provisioning.ts` | profile fields + Entra OID |
| `/me/manager`    | `entra-provisioning.ts` | manager linking (Phase 3B) |
| `/me/photo`      | `graph-photo.ts`        | avatar sync to Vercel Blob |
| `/me/sendMail`   | `graph-email.ts`        | activity-tracked email send |
| `/me/events`     | `graph-meeting.ts`      | calendar invite scheduling |

Tokens (access + refresh) live in `accounts.access_token` / `refresh_token`.
The JWT does **not** carry them — too large, would push us into chunked
cookies. `graph-token.ts` refreshes when expired.

`ReauthRequiredError` is thrown when refresh fails; the UI catches and shows a
"Reconnect Microsoft" banner.

### Vercel Blob
Single private store `store_q0tdhrIEiOxbRAQt` ("mwg-crm-blob", region iad1).
Two namespaces:
- `users/<userId>/photo.jpg` — synced from `/me/photo` on first sign-in / refresh.
- `attachments/<activityId>/<filename>` — files attached to activity rows.

Phase 4A: file uploads validated via `src/lib/validation/file-upload.ts` —
magic-byte check + MIME allowlist + 10 MB cap + extension blocklist. Filenames
sanitized via `sanitizeFilename()`.

## 7. Concurrency model

**Optimistic concurrency control (OCC)** via a `version int NOT NULL DEFAULT 1`
column on every mutable record:

```
leads, crm_accounts, contacts, opportunities, tasks,
saved_views, user_preferences
```

Every UPDATE goes through `concurrentUpdate()` (`src/lib/db/concurrent-update.ts`)
which adds `WHERE version = $expected` and bumps it in the same statement.
Zero rows affected → either the record is gone (`NotFoundError`) or someone
else moved the version (`ConflictError`).

UI surfaces `ConflictError` as a non-auto-dismissing toast (`duration:
Infinity, dismissible: true`): *"This record was modified by someone else.
Refresh to see their changes, then try again."* Forms must read `version`
and post it back. A polished banner with names + "View their changes /
Discard mine" UI is tracked in `ROADMAP.md` as deferred polish.

**OCC paths wired (Phase 6B):**
- `updateLeadAction` (`lib/leads.ts:updateLead`)
- `updateTaskAction` + `toggleTaskCompleteAction` (`lib/tasks.ts:updateTask`)
- `updateViewAction` (`lib/views.ts:updateSavedView`)
- `updatePreferencesAction` (UPSERT with `setWhere: eq(version, expected)`)

**Where last-write-wins is acceptable** — documented exceptions:
- `audit_log` — append-only; never updated.
- `notifications` — only the `is_read` flag changes, only by the owner.
- `recent_views` — upsert with timestamp; race conditions just dedupe.
- `lead_tags` — insert/delete only.
- Drag-drop status changes (`updateLeadStatusAction`,
  `updateOpportunityStageAction`) — single-field, no row form;
  threading version through drag state was deemed not worth the
  invasiveness given the realistic UX is "last-drag-wins by user
  choice." Revisit if collisions show up in production.

## 8. Logging and error handling

`src/lib/logger.ts` is the **only** sanctioned logger. JSON-line format,
key redaction for `password|token|secret|cookie|...`, levels
ERROR/WARN/INFO/DEBUG. `console.*` is forbidden in committed code with three
documented exceptions:
- `src/lib/logger.ts` itself (uses `console.error`/`console.log` for stdio).
- `src/lib/env.ts` (loaded before logger; circular import).
- `src/db/index.ts onnotice` (driver-level callback; same).

`KnownError` hierarchy in `src/lib/errors.ts`:
`ValidationError | NotFoundError | ForbiddenError | ConflictError | RateLimitError`.
Each has a `publicMessage` that's safe to show in the UI.

`withErrorBoundary` (`src/lib/server-action.ts`) wraps server actions and
route handlers. Catches all throws, translates Zod issues into
`ValidationError`, logs success/failure with timing, returns a stable
`ActionResult<T>` shape: `{ ok, data } | { ok: false, error, code, requestId }`.

## 9. Authorization gates

`src/lib/access.ts` — `requireXAccess(id, userId, action)` for accounts,
contacts, opportunities, tasks, and saved_views. Each:
- Loads the row by id (throws `NotFoundError` if missing).
- Returns the row if owner / admin / has-all-records permission.
- Otherwise calls `denyAndLog()` which writes an `access.denied.*` audit
  event and throws `ForbiddenError`.

Lead access predates Phase 4 and lives in `src/lib/auth-helpers.ts`
(`requireLeadAccess`, `requireLeadEditAccess`) — same pattern, kept where it is
to avoid churning Phase 2 call sites.

## 9b. Import pipeline (Phase 6)

**Two-step preview-then-commit flow** at `/leads/import`:

1. **Upload + parse** (`previewImportAction`) reads the .xlsx via exceljs,
   maps headers via `lib/import/headers.ts`, hands each row to
   `parseImportRow`, and stashes the `ParsedRow[]` under a job id in an
   in-process TTL cache (`lib/import/job-cache.ts`).
2. **Preview** (`buildImportPreview`) batch-resolves owner emails +
   activity By-name strings (two queries total), looks up existing
   leads by `external_id`, and aggregates everything into counts +
   warning groups + per-row errors. Renders without touching writes.
3. **Commit** (`commitImportAction` → `commitImport`) processes in
   chunks of 100 rows; updates existing leads (`external_id` match)
   via the OCC pattern, inserts new ones, computes activity dedup
   keys, creates lead-only opportunities (no `account_id` —
   conversion adds the account later), upserts tags with autocreated
   slugs. Failures are caught per-chunk so partial success is
   preserved. One audit row per import describes the snapshot.

**Smart-detect** is a one-shot bridge for legacy D365 dumps where
everything (Topic, Phone Calls, Notes, Linked Opportunity, Description)
is crammed into the Description column. Opt-in via a checkbox on the
upload screen. `lib/import/d365-detect.ts` recognises the shape, splits
sections, and dispatches each section to the multi-line activity
parser. New imports should use the dedicated columns.

**`import_dedup_key`** = `sha256(lead_id + kind + occurred_at_iso +
body[0..200])`. Set on every imported activity; never set on
manually-created activities. The `activities_import_dedup_idx` partial
index lets re-imports of the same file skip already-present
activities idempotently.

**`imported_by_name`** snapshots a "By: Name" reference from a parsed
activity body when the name doesn't resolve to a CRM user. Future
admin tooling will let an admin remap historical activities to a real
user once the person signs up.

## 9.5. Phase 9 — scale prep

The Phase 9C work assumes the production target is **100k+ leads,
1M+ activities, 40–80 concurrent users** (40 active in business
hours, peak ~80 during cross-team cadence calls). No new tables, no
schema redesign — pagination + indexes only.

### Pagination strategy

Every list page that touches a high-volume table moved from offset
to **cursor pagination** at page size 50 (audit: 100). Cursors are
plaintext `<sort-key-value>:<uuid>` strings — opaque to the client,
trivially diffable in URLs. The codec lives in `src/lib/leads.ts`
(`parseCursor` / `encodeCursor`), with thin variants in `lib/tasks.ts`
and `lib/notifications.ts` for sort columns of different types.

| Surface | Module | Sort key | Page size |
|---|---|---|---|
| `/leads` (default sort) | `runView` in `lib/views.ts` | `(last_activity_at DESC NULLS LAST, id DESC)` | 50 |
| `/leads` (custom sort) | `runView` in `lib/views.ts` | offset fallback | 50 |
| `/accounts` | inline in `app/(app)/accounts/page.tsx` | `(updated_at DESC, id DESC)` | 50 |
| `/contacts` | inline in `app/(app)/contacts/page.tsx` | `(updated_at DESC, id DESC)` | 50 |
| `/opportunities` | inline in `app/(app)/opportunities/page.tsx` | `(expected_close_date DESC NULLS LAST, id DESC)` | 50 |
| `/tasks` | `listTasksForUser` in `lib/tasks.ts` | `(assigned_to_id, due_at ASC NULLS LAST, id DESC)` | 50 |
| `/notifications` | `listNotificationsPage` in `lib/notifications.ts` | `(user_id, created_at DESC, id DESC)` | 50 |
| `/admin/audit` | inline in `app/admin/audit/page.tsx` | `(created_at DESC, id DESC)` | 100 |
| `listLeads` (export) | `lib/leads.ts` | offset (`pageSize=10000`) | n/a |

The `pageSize + 1` row trick replaces a separate `COUNT(*)` query —
the page-fetch grabs one extra row, slices it off if present, and
emits a `nextCursor` from the last surviving row. UI surfaces
"Load more" / "Back to start" links instead of "Page X of Y".

`listLeads` keeps the offset path for the leads-export route (a
single-shot 10k-row download) — the COUNT it skips on the cursor
path is still cheap at that pageSize and the caller doesn't need
incremental pagination.

### Composite indexes for cursor seeks

Eight composite indexes added (Phase 9C migrations
`phase9_idx_*`); see `PHASE9-INDEX-AUDIT.md` §2 for the full table.
Pattern: `(sort_col DESC[, NULLS LAST], id DESC) WHERE is_deleted = false`.
Partial-on-`is_deleted=false` shrinks the index to live rows only,
which matters once archive data accumulates. The `id DESC` tail
makes cursor seeks deterministic when many rows share a timestamp
to the millisecond (bulk imports, audit bursts).

### Connection pool

No changes from Phase 1: postgres-js with `max: 1`, `prepare: false`,
`idle_timeout: 20`, `connect_timeout: 10`. Supavisor IS the pool;
each Lambda just needs one connection through it. See
`drizzle_supavisor_max1` memory.

### `statement_timeout` convention

Cursor-paginated list queries are index-scan-then-LIMIT — they exit
fast and don't need a per-statement timeout. The single in-app
`SET LOCAL statement_timeout = '5s'` lives in `app/admin/audit/page.tsx`
when a free-text `q=` filter is applied; the audit log has no FTS /
trigram index across `target_id` (text-not-uuid) so an unbounded ILIKE
at 1M+ rows is the actual risk. Use `SET LOCAL` (transaction-scoped)
not `SET` so timeouts don't leak across pooled callers. Document each
new timeout in `PHASE9-INDEX-AUDIT.md` §5.

## 10. Notable decisions

- **Why no DrizzleAdapter for Auth.js**: its expected user-table shape
  (`name`, `emailVerified`, `image`) conflicts with our own (`first_name`,
  `last_name`, `display_name`, `photo_blob_url`, …). We manage the
  `accounts` row manually via `upsertAccount()`.
- **Why `max: 1` on postgres-js**: drizzle-orm ≥ 0.45 + Supavisor needed it
  to stop intermittent connection failures. See `drizzle_supavisor_max1`
  memory.
- **Why xlsx remains accepted-risk**: SheetJS no longer ships fixes via npm.
  Mitigations: `import "server-only"`, admin-only upload, 25 MB cap,
  magic-byte validation, 10k-row cap, chunked transactions, capped
  failed-rows list. See `SECURITY-NOTES.md`.
- **Why no PRs**: small team, master-only repo, push-and-deploy via Vercel.
  See `feedback_no_pr_workflow` memory.
- **Why Server Actions over a separate API**: the only client-only surfaces
  (Cmd+K palette, Kanban drag) get small purpose-built `/api/*` routes.
  Everything else is a Server Action; saves a network hop and a build target.
