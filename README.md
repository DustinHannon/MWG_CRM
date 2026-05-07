# MWG CRM

Internal CRM platform for **Morgan White Group**. Replaces ~30% of the Dynamics 365 Sales feature set MWG actually uses, on a self-hosted, Vercel-deployed stack.

**Live**: <https://mwg-crm.vercel.app>
**Repo**: <https://github.com/DustinHannon/MWG_CRM>

## Status (2026-05-06)

Phases 1–9 deployed and live. Phase 7 (Microsoft Graph integration — email/calendar tracking) is wired but inert until the Entra App Registration credentials are added; everything else is functional end-to-end.

| # | Phase | Status |
|---|---|---|
| 1 | Provisioning (Supabase, Vercel Blob, env vars, deps) | ✅ |
| 2 | Schema + breakglass auth | ✅ |
| 3 | Entra OIDC provider | ✅ wired, awaits client ID/secret |
| 4 | Admin foundation (users, perms, audit log writes) | ✅ |
| 5 | Leads CRUD | ✅ |
| 6 | Activities (notes, calls, tasks) | ✅ |
| 7 | Microsoft Graph (email, meetings, photo cache) | ⏳ awaits §3 credentials |
| 8 | Excel import / export | ✅ |
| 9 | Admin data tools + audit viewer + settings | ✅ |
| 10 | UI polish (fonts, glass, navy palette) | ✅ baseline |
| 11 | README + ops docs | ✅ |

## Tech stack

- **Next.js 16** (App Router, Turbopack) on **React 19**
- **TypeScript** strict mode, **Tailwind v4**, **ESLint flat config**
- **Drizzle ORM** + **postgres-js** against **Supabase Postgres**
- **Auth.js v5** (`next-auth@beta`) — Credentials (breakglass) + MicrosoftEntraID providers, JWT sessions
- **@node-rs/argon2** for password hashing (argon2id)
- **SheetJS (xlsx)** for import / export
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
| XLSX | `src/lib/xlsx-template.ts`, `src/lib/xlsx-import.ts` |
| Edge proxy | `src/proxy.ts` (Next 16 renamed `middleware`) |

Routes (App Router):

```
/                              redirect ↔ /dashboard | /auth/signin
/auth/{signin,disabled}        public
/api/auth/[...nextauth]        Auth.js handlers
/api/leads/import-template     XLSX template download (auth + can_import)
/api/leads/export              filtered XLSX export (auth + can_export)
/dashboard                     KPIs + recent leads
/leads                         table + filters + pagination + bulk actions
/leads/new                     create (can_create_leads)
/leads/[id]                    detail + activity composer + feed
/leads/[id]/edit               edit (can_edit_leads)
/leads/import                  XLSX wizard (can_import)
/admin                         overview (is_admin)
/admin/users                   user list
/admin/users/[id]              edit perms / admin / active / rotate breakglass
/admin/audit                   searchable audit log
/admin/data                    type-to-confirm delete-all flows
/admin/settings                read-only env config
```

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

Phase 7 stubs Vercel cron endpoints for `/api/jobs/sync-sent-items` and `/api/jobs/sync-calendar`. To enable, add to `vercel.json` once Phase 7 is fully fleshed out:

```json
{
  "crons": [
    { "path": "/api/jobs/sync-sent-items", "schedule": "0 */1 * * *" },
    { "path": "/api/jobs/sync-calendar", "schedule": "0 */1 * * *" }
  ]
}
```

## Phase 7 — Microsoft Graph (pending Entra credentials)

The Auth.js Microsoft Entra provider is registered and the user provisioning flow (`src/lib/entra-provisioning.ts`) is wired per the brief §7.3 — including Graph `/me` lookup with `givenName` / `surname` / `displayName` resolution, domain allowlist enforcement, and refresh-token persistence on `accounts`.

To activate:

1. Create the App Registration in entra.microsoft.com (single tenant, MWG). Redirect URIs:
   - `https://mwg-crm.vercel.app/api/auth/callback/microsoft-entra-id`
   - `http://localhost:3000/api/auth/callback/microsoft-entra-id`
2. Delegated Graph permissions to grant: `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `Calendars.Read`, `Calendars.ReadWrite`. Click **Grant admin consent**.
3. Generate a client secret (24-month lifetime, copy the VALUE).
4. `vercel env add AUTH_MICROSOFT_ENTRA_ID_ID production` (paste client ID).
5. `vercel env add AUTH_MICROSOFT_ENTRA_ID_SECRET production` (paste secret VALUE).
6. Redeploy: `vercel --prod` or push any commit to `master`.

After redeploy, the Microsoft sign-in button on `/auth/signin` becomes active. The Send Email / Schedule Meeting / Track Email actions on `/leads/[id]` and the cron-driven sent-items sync land as Phase 7 fills in.

## Open items / non-goals (v1)

- **No app-level rate limiting** on Microsoft Graph — relies on Graph's own throttling. Add via Vercel Routing Middleware if abuse appears.
- **No Outlook add-in "Track" button** — that's Phase 2 (post-v1). The data model and `/me/messages?$filter=internetMessageId eq …` track endpoint are ready for it.
- **No converted/Account/Contact/Opportunity tables** — v1 keeps a `converted_at` timestamp on `leads` only.
- **No multi-tenant** — single tenant, MWG only.

## License

Internal MWG software. Not for redistribution.
