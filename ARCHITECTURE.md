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

UI surfaces `ConflictError` as a non-dismissable banner: *"This record was
modified by someone else. Refresh to see their changes, then try again."* Forms
must read `version` and post it back; the banner gives the user a "View their
changes / Discard mine" choice.

**Where last-write-wins is acceptable** — documented exceptions:
- `audit_log` — append-only; never updated.
- `notifications` — only the `is_read` flag changes, only by the owner.
- `recent_views` — upsert with timestamp; race conditions just dedupe.
- `lead_tags` — insert/delete only.

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
