# MWG CRM

Internal CRM platform for **Morgan White Group**. Replaces ~30% of the Dynamics 365 Sales feature set MWG actually uses, on a self-hosted, Vercel-deployed stack.

**Live**: <https://mwg-crm.vercel.app>
**Repo**: <https://github.com/DustinHannon/MWG_CRM>

## Status (2026-05-07)

Phases 1–9 (v1) and Phase 3 (v2 features) all deployed and live.

| # | Phase | Status |
|---|---|---|
| 1 | Provisioning (Supabase, Vercel Blob, env vars, deps) | ✅ |
| 2 | Schema + breakglass auth | ✅ |
| 3 | Entra OIDC provider | ✅ |
| 4 | Admin foundation (users, perms, audit log writes) | ✅ |
| 5 | Leads CRUD | ✅ |
| 6 | Activities (notes, calls, tasks) | ✅ |
| 7 | Microsoft Graph (email, meetings, photo cache) | ✅ |
| 8 | Excel import / export | ✅ |
| 9 | Admin data tools + audit viewer + settings | ✅ |
| 10 | UI polish (fonts, glass, navy palette) | ✅ |
| 11 | README + ops docs | ✅ |
| 2A | Dropdown rendering + Apply button bug fix | ✅ |
| 2B | Security review (deps + horiz priv-esc + headers) | ✅ |
| 2C-2E | Integrity, schema, DNC, admin promotion | ✅ |
| 2F | Saved views, dashboard charts, lead provenance, admin user delete | ✅ |
| 3A | Glass token system + GlassCard primitive | ✅ |
| 3B | User panel redesign + /settings page + Entra extended profile | ✅ |
| 3C | Tags as first-class entity | ✅ |
| 3D | Tasks + notifications + @-mentions + due-today cron | ✅ |
| 3E | Pipeline Kanban view (drag-drop status updates) | ✅ |
| 3F | Duplicate detection on lead create | ✅ |
| 3G | Lead conversion + Account/Contact/Opportunity entities | ✅ |
| 3H | Saved-search subscriptions + email digests via Graph | ✅ |
| 3I | Cmd+K command palette + recent_views | ✅ |
| 3J | Strict CSP with per-request nonces | ✅ |

## Tech stack

- **Next.js 16** (App Router, Turbopack) on **React 19**
- **TypeScript** strict mode, **Tailwind v4**, **ESLint flat config**
- **Drizzle ORM** + **postgres-js** against **Supabase Postgres**
- **Auth.js v5** (`next-auth@beta`) — Credentials (breakglass) + MicrosoftEntraID providers, JWT sessions
- **@node-rs/argon2** for password hashing (argon2id)
- **exceljs** for import / export (migrated from SheetJS in Phase 5G)
- **libphonenumber-js** for phone normalisation on import
- **Vercel Blob** (private) for attachments and cached profile photos
- **Microsoft Graph** via `fetch` with delegated tokens (no SDK)
- **next/font** for self-hosted Geist (UI) / Fraunces (display) / JetBrains Mono (code)

## Architecture quick-reference

| Concern | Location |
|---|---|
| Env validation | `src/lib/env.ts` (zod, fail-fast on boot) |
| DB client | `src/db/index.ts` (postgres-js with `prepare:false` for Supabase pooler) |
| Schema | `src/db/schema/*.ts` + `drizzle/0000_*.sql` migration |
| Auth config | `src/auth.ts` |
| Entra provisioning | `src/lib/entra-provisioning.ts` |
| Breakglass init | `src/lib/breakglass.ts` |
| Audit writes | `src/lib/audit.ts` |
| Auth helpers | `src/lib/auth-helpers.ts` (`requireSession`, `requireAdmin`, `requirePermission`) |
| Lead queries | `src/lib/leads.ts` |
| Activity queries | `src/lib/activities.ts` |
| XLSX template + export | `src/lib/xlsx-template.ts`, `src/lib/xlsx-import.ts` |
| Import pipeline (Phase 6) | `src/lib/import/*.ts` (parse-row, parse-workbook, preview, commit, headers, normalize, dedup-key, resolve-users, d365-detect, activity-parser, stage-mapping) |
| Edge proxy | `src/proxy.ts` (Next 16 renamed `middleware`) |

Routes (App Router):

```
/                              redirect ↔ /dashboard | /auth/signin
/auth/{signin,disabled}        public
/api/auth/[...nextauth]        Auth.js handlers
/api/leads/import-template     XLSX template download (auth + can_import)
/api/leads/export              filtered XLSX export (auth + can_export)
/api/leads/check-duplicate     duplicate detection on lead create (Phase 3F)
/api/search                    Cmd+K cross-entity search (Phase 3I)
/api/cron/tasks-due-today      bearer-auth, daily 14:00 UTC (Phase 3D)
/api/cron/saved-search-digest  bearer-auth, daily 14:00 UTC (Phase 3H)
/dashboard                     KPIs + 4 charts
/leads                         table + filters + saved views + pagination
/leads/new                     create (can_create_leads) + dup warnings
/leads/[id]                    detail + activity composer + feed + Convert
/leads/[id]/edit               edit (can_edit_leads)
/leads/import                  XLSX wizard (can_import)
/leads/pipeline                Kanban by status (Phase 3E)
/accounts, /accounts/[id]      CRM Account records (Phase 3G)
/contacts, /contacts/[id]      Contact records (Phase 3G)
/opportunities, /opportunities/[id]      Opportunity records (Phase 3G)
/opportunities/pipeline        Kanban by stage (Phase 3G)
/tasks                         my tasks (Phase 3D)
/notifications                 full bell-icon list (Phase 3D)
/settings                      6-section profile + prefs (Phase 3B)
/admin                         overview (is_admin)
/admin/users, /admin/users/[id]      user mgmt
/admin/tags                    tag management (Phase 3C)
/admin/audit                   searchable audit log
/admin/data                    type-to-confirm delete-all flows
/admin/settings                read-only env config
```

## Phase 3 — what's new

**Entities and relationships:**
- Lead → (Convert) → Account + Contact + Opportunity (single transaction). Existing activities reassign to the new opportunity.
- `permissions.can_view_all_leads` was renamed to `can_view_all_records` — one flag governs visibility across all four CRM record types.
- Activities now optionally attach to any of {lead, account, contact, opportunity}. Database CHECK constraint enforces exactly-one-parent.
- Tasks similarly, but at-most-one-parent (orphaned tasks allowed).

**New cron jobs (registered in `vercel.json`):**
- `/api/cron/tasks-due-today` — daily 14:00 UTC. Creates `task_due` notifications for assignees with `notify_tasks_due=true`.
- `/api/cron/saved-search-digest` — daily 14:00 UTC. For each active saved-search subscription, creates in-app notifications and (optionally) sends an email digest from the user's own M365 mailbox via Graph.

**Required env var added:** `CRON_SECRET` (≥20 chars). Both crons reject requests without `Authorization: Bearer $CRON_SECRET`.

**UI surfaces:**
- Bottom-left of sidebar is now a clickable user panel (avatar + name + title) with a Settings/Sign out popover. Theme toggle moved exclusively to /settings.
- /settings has six sections: Profile (read-only Entra fields with lock icons), Preferences (theme/timezone/formats/density/landing/leads view — auto-saving), Notifications, Microsoft 365 connection, Account info, Danger zone.
- Notifications bell at the top-right of every authenticated page. `Cmd+K` / `Ctrl+K` opens a global command palette (search across leads/contacts/accounts/opportunities/tasks/tags + recent + quick actions).
- Pipeline Kanban for leads (`/leads/pipeline`) and opportunities (`/opportunities/pipeline`) with drag-drop status/stage updates.
- Tags are first-class with a fixed color palette; combobox autocomplete with create-on-the-fly, /admin/tags management.
- Duplicate detection on lead create (debounced /api/leads/check-duplicate).

**Schema migrations applied (Phase 3):**
1. `phase3_entra_profile_fields` — extended `users` profile fields synced from Graph
2. `phase3_user_prefs_extension` — editable preferences (timezone, date/time format, density, notify_*, email_digest_frequency, leads_default_mode)
3. `phase3_tags` — `tags` + `lead_tags` (backfilled from `leads.tags` text[])
4. `phase3_tasks_notifs` — `tasks` + `notifications` (with `task_status` / `task_priority` enums)
5. `phase3_records` — `crm_accounts` (collision avoidance with Auth.js `accounts`), `contacts`, `opportunities` + activities/tasks parent FKs + CHECK constraints
6. `phase3_perms_rename` — `can_view_all_leads` → `can_view_all_records`
7. `phase3_subscriptions` — `saved_search_subscriptions`
8. `phase3_recent_views` — `recent_views` (Cmd+K MRU)

**Security tightening:** strict CSP with per-request nonces is now generated in `src/proxy.ts` (replaces the static permissive CSP from `next.config.ts`). `style-src 'unsafe-inline'` is retained as a pragmatic compromise for shadcn/Radix runtime style injection — documented in `SECURITY-NOTES.md`.

## Phase 4 — what's new

Phase 4A is a **defense-in-depth hardening pass**; 4B–H ship features on top of it. See `ARCHITECTURE.md` and `SECURITY-NOTES.md` (both updated).

**4A — Hardening foundations:**
- `src/lib/logger.ts` — structured JSON logger with key redaction. Forbidden across the codebase: bare `console.*` (3 documented boot-path exceptions).
- `src/lib/errors.ts` + `src/lib/server-action.ts` — `KnownError` hierarchy + `withErrorBoundary` wrap for every server action / route handler. Public errors carry a `requestId`; stacks never leak in production.
- `src/lib/validation/primitives.ts` — Zod field validators (`nameField`, `emailField`, `phoneField`, `urlField`, `currencyField`, `dateField`, `noteBody`, `tagName`).
- `src/lib/validation/file-upload.ts` — magic-byte + MIME + size enforcement.
- `src/lib/access.ts` — IDOR access gates for accounts/contacts/opportunities/tasks/saved-views. Lead gates pre-existing in `auth-helpers.ts`.
- `src/lib/db/concurrent-update.ts` — optimistic-concurrency UPDATE helper. Every mutable record now has a `version` column.
- `scripts/orphan-scan.ts` — DB + Vercel Blob orphan scanner (zero rows at Phase 4 baseline).

**4B — View management:** `createViewAction` clears the user's adhoc-column override after saving a built-in view's modified state as a new view, so the originating built-in returns to clean defaults.

**4C — Lead scoring (rules-based):** `lead_scoring_rules` table + `leads.score / score_band / scored_at`. Engine in `src/lib/scoring/engine.ts`. Predicate format mirrors saved-views filters; pseudo-fields `last_activity_within_days` and `activity_count` available. Bands: `hot ≥70 / warm 40-69 / cool 15-39 / cold <15`. `<ScoreBadge>` component for displays. Daily cron `/api/cron/rescore-leads` at 09:00 UTC.

**4E — Bulk tag operations (backend):** `bulkTagLeadsAction` server action — capped 1000 leads per call, refuses entire batch on any access failure, transactional ON CONFLICT DO NOTHING / DELETE, audit row per lead. Selection-toolbar UI deferred.

**4F — Print / Save-as-PDF:** `/leads/print/[id]` route outside the (app) chrome. Auto-fires `window.print()` on load; user picks Save-as-PDF from the system print dialog. `Print / PDF` link in the lead detail header. No server-side Chromium required.

**4G — Soft delete:** `is_deleted / deleted_at / deleted_by_id / delete_reason` on leads/accounts/contacts/opportunities/tasks. Default queries filter `is_deleted=false`. The "Delete" button now archives; admin-only `/leads/archived` view restores or hard-deletes. Daily cron `/api/cron/purge-archived` at 10:00 UTC purges archives older than 30 days, with row snapshot in `audit_log`.

**4H — Full-text search:** `pg_trgm` + `unaccent` extensions; functional GIN FTS + trigram indexes on `leads`, `crm_accounts`, `contacts`, `opportunities`. Cmd+K rewrite uses `websearch_to_tsquery` + similarity union ranking. Typo-tolerant.

**Schema migrations applied (Phase 4):**
1. `phase4_db_hardening` — RLS on missing tables, `audit_log.actor_email_snapshot`, ~24 covering indexes for FK CASCADE/SET NULL chains.
2. `phase4_check_constraints` — DB-layer name/email/url/numeric/date bounds.
3. `phase4_versioning` — `version int NOT NULL DEFAULT 1` for OCC.
4. `phase4_soft_delete` — soft-delete columns + partial active/deleted indexes.
5. `phase4_lead_scoring` — `lead_scoring_rules` + `leads.score / score_band / scored_at`.
6. `phase4_fts_indexes` — `pg_trgm` + `unaccent` extensions; FTS + trigram indexes.

**Deferred (tracked in ROADMAP.md):**
- 4D forecasting dashboard, 4I mobile responsiveness pass, 4J manager → CRM user linking.
- 4B drag-and-drop column reorder UI (the auto-revert backend ships now).
- 4E selection-toolbar UI on the leads list (the bulk-tag server action ships now).
- 4C `/admin/scoring` rule-builder UI (the engine + cron + badge ship now; admins create rules via SQL or future UI).

## Environment variables

Set every one of these on Vercel (production scope) before the deploy works at runtime. `src/lib/env.ts` validates them all on boot — the build fails loudly if anything's missing.

| Variable | Required | Source / Notes |
|---|---|---|
| `AUTH_SECRET` | yes | `openssl rand -base64 32` |
| `AUTH_TRUST_HOST` | yes | `true` on Vercel |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | optional v1 | App Registration "Application (client) ID" — Phase 3 lights up SSO |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | optional v1 | Client secret VALUE (not ID), 24-month lifetime |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | yes | `https://login.microsoftonline.com/<tenant_id>/v2.0` |
| `POSTGRES_URL` | yes | Supabase pooler; see [DB connection](#database-connection) |
| `POSTGRES_URL_NON_POOLING` | yes | Same Supabase pooler (session mode, port 5432) |
| `BLOB_READ_WRITE_TOKEN` | yes | Auto-set by `vercel blob create-store --yes` |
| `APP_NAME` | optional | Default `MWG CRM` |
| `ALLOWED_EMAIL_DOMAINS` | yes | Comma-separated, lowercase |
| `DEFAULT_TIMEZONE` | optional | Default `America/Chicago` |
| `CRON_SECRET` | yes (Phase 3D, 3H) | ≥20 chars. Bearer-auth for `/api/cron/*` routes. Set with `vercel env add`. |

`.env.example` documents these with no secrets. For local development, `.env.local` (gitignored) holds your dev values; Vercel's CLI `vercel env pull` does NOT pull values for prod-encrypted vars to local — you must populate them by hand once.

## Database connection

We use a **custom Postgres role `mwg_crm_app`** (not `postgres`) because Supabase's Management API runs as a non-superuser `postgres` and can't ALTER USER on the privileged `postgres` role. The custom role has `LOGIN` and `BYPASSRLS` so it ignores Row Level Security (we do auth in app code, not RLS).

Connection format:

```
postgresql://mwg_crm_app.<project_ref>:<password>@aws-1-us-east-1.pooler.supabase.com:<port>/postgres?sslmode=require
```

- Port `5432` = session pool (used for both `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING` because the transaction-mode pool caches role passwords longer than session mode does).
- `prepare: false` is set on the postgres-js client (`src/db/index.ts`) — required by Supavisor.
- All 10 tables have `ALTER TABLE … ENABLE ROW LEVEL SECURITY` with **no** policies — defense-in-depth that blocks PostgREST's anon/authenticated roles. `mwg_crm_app` bypasses RLS, so app traffic is unaffected.

## Setup from scratch (future engineer)

```bash
# Clone + install
git clone https://github.com/DustinHannon/MWG_CRM.git
cd MWG_CRM
pnpm install

# Pull env (pulls non-secret vars; fill the rest into .env.local by hand)
vercel link                         # if not yet linked
vercel env pull .env.local

# Run locally
pnpm dev                            # http://localhost:3000

# Build
pnpm build && pnpm lint && pnpm typecheck

# Schema changes — author in src/db/schema/, generate, then apply
pnpm db:generate
# Then apply via Supabase MCP `apply_migration` (preferred) or
# drizzle-kit migrate against POSTGRES_URL_NON_POOLING.
```

## Operations

### Retrieving the breakglass password

The breakglass account self-seeds on first deploy. The plaintext password is logged exactly once to stdout. Retrieve it with:

```bash
vercel logs https://mwg-crm.vercel.app --no-follow --since=15m --json | grep BREAKGLASS
```

The MCP `get_runtime_logs` truncates long messages, so use the CLI for the full log line. After Phase 4, an admin can rotate the password from **Admin → Users → breakglass → Rotate breakglass password** (the new plaintext shows once in a modal).

### Promoting a user to admin

1. Sign in via breakglass at `/auth/signin`.
2. Go to **Admin → Users**, click the user.
3. Toggle **Administrator** on. Audit log records the change.

### Forcing a user to re-authenticate

**Admin → Users → [user] → Force re-auth** bumps `users.session_version`. The next request from any of that user's outstanding JWTs returns `null` in the `jwt` callback, which Auth.js treats as session-invalid, triggering a re-sign-in.

### Audit log

`/admin/audit` is a paginated, searchable view of every admin mutation, lead delete, permission change, import, etc. It's append-only. Each row carries a `before_json` / `after_json` diff for changes.

### Deleting all data

`/admin/data` has type-to-confirm flows for deleting all leads, all activities, or all import history. There is no undo. Each operation cascades via FKs and writes an audit row.

### Cron (background sync)
<a id="cron-background-sync"></a>

Phase 7 stubs Vercel cron endpoints for `/api/jobs/sync-sent-items` and `/api/jobs/sync-calendar`. To enable, add to `vercel.json` once Phase 7 is fully fleshed out:

```json
{
  "crons": [
    { "path": "/api/jobs/sync-sent-items", "schedule": "0 */1 * * *" },
    { "path": "/api/jobs/sync-calendar", "schedule": "0 */1 * * *" }
  ]
}
```

## Phase 6 — import pipeline (live)

Implemented 2026-05-07. End-to-end flow:

- **`/leads/import`** — three-step UI: upload + preview + commit. Smart-detect checkbox for legacy D365 dumps. Download-template button next to the file picker.
- **39-column template** generated by `src/lib/xlsx-template.ts`. Three sheets: Leads (3 example rows), Instructions (column docs + multi-line activity format + status/stage mappings), Allowed values (enum cheat sheet).
- **Multi-line activity columns** (Notes, Phone Calls, Meetings, Emails). Each cell can hold multiple bracketed-timestamp entries with metadata. Parser at `src/lib/import/activity-parser.ts`.
- **Smart-detect** (`src/lib/import/d365-detect.ts`): one-shot bridge for legacy D365 exports where everything is in the Description column (Topic, Phone Calls, Linked Opportunity, etc.). Section-aware splitter handles nested `Description:` inside `Linked Opportunity:` blocks.
- **Re-import idempotency**: `external_id` matches existing leads (updated via the OCC pattern); activities deduped via `sha256(lead_id + kind + occurred_at + body[0..200])` against the `activities_import_dedup_idx` partial index.
- **`imported_by_name` snapshots** activity By-name references that don't resolve to a CRM user; UI renders these with an "(imported)" hint.
- **Admin docs** at `/admin/import-help`. Synthetic-file smoke documented in `PHASE6-IMPORT-TEST.md`; production smoke against `mwg-crm-leads-batch-0447.xlsx` runs once the file is placed at `./test-data/`.

How to add a new import column:
1. Add an entry to `TEMPLATE_HEADERS` in `src/lib/import/headers.ts`.
2. Add the matching field to the Zod schema in `src/lib/import/row-schema.ts`.
3. Add the cell-level normalisation to `src/lib/import/parse-row.ts` (the `candidate` object).
4. Add the column to the lead schema (Drizzle + Supabase migration).
5. Add the `set: ...` clause for both the INSERT and UPDATE branches in `src/lib/import/commit.ts`.

How to add a new activity kind to the parser:
1. Extend `ActivityKind` in `src/lib/import/activity-parser.ts`.
2. Add a metadata-line regex (analogous to `parseCallOrEmailMetaLine`).
3. Add a kind branch inside the dispatch loop.
4. (If smart-detect should pick it up too) extend `SECTION_LABELS` in `d365-detect.ts`.

## Phase 7 — Microsoft Graph (live)

Implemented:
- **Token refresh** (`src/lib/graph-token.ts`): `getValidAccessTokenForUser(userId)` reads the `accounts` row, refreshes when `expires_at` is within 60s, persists rotated tokens. `ReauthRequiredError` thrown on `invalid_grant` is caught by the UI and surfaces a "Reconnect Microsoft" button that re-runs `signIn("microsoft-entra-id")` with `redirectTo` set to the current page.
- **Send Email** (`src/lib/graph-email.ts`): `/me/sendMail` with `saveToSentItems:true`, then walks Sent Items by subject + recipient (5 attempts × 700ms) to fetch the message back. Persists as an `activities` row with `kind=email`, `direction=outbound`, `graph_message_id`, `graph_internet_message_id`. Inline base64 attachments capped at 3MB each (v1 limit; larger needs `createUploadSession`). Graph attachments are pulled down and re-stored to Vercel Blob with a stable pathname.
- **Schedule Meeting** (`src/lib/graph-meeting.ts`): `POST /me/events` with attendee + start/end + timezone + location, persists as `kind=meeting` with `graph_event_id` and `meeting_attendees` jsonb.
- **Profile photo cache** (`src/lib/graph-photo.ts`): `/me/photo/$value` → public Vercel Blob, 24-hour TTL. 404 short-circuits retries for a day.

UI surface: `GraphActionPanel` on `/leads/[id]` with Send email / Schedule meeting tabs (gated by `canSendEmail` or admin; hidden when `do_not_email=true`).

Not yet wired (post-v1):
- The Outlook add-in "Track" button.
- A "Track existing email" manual-track endpoint that takes an Outlook web URL or internet message ID and pulls the message into the activity feed.
- Cron-driven background sync of sent items + calendar — see [Cron section](#cron-background-sync) below for the stub config.

## Open items / non-goals (v1)

- **No app-level rate limiting** on Microsoft Graph — relies on Graph's own throttling. Add via Vercel Routing Middleware if abuse appears.
- **No Outlook add-in "Track" button** — that's Phase 2 (post-v1). The data model and `/me/messages?$filter=internetMessageId eq …` track endpoint are ready for it.
- **No converted/Account/Contact/Opportunity tables** — v1 keeps a `converted_at` timestamp on `leads` only.
- **No multi-tenant** — single tenant, MWG only.

## License

Internal MWG software. Not for redistribution.
