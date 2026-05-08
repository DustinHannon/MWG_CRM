# Realtime architecture (Phase 12)

This document captures the design of the Phase 12 realtime layer so
future contributors understand which moving parts are platform vs app.

---

## High-level shape

```
┌─────────────────┐                   ┌─────────────────────┐
│   Browser       │  WebSocket+JWT    │  Supabase Realtime  │
│  (Next.js app)  │ ───────────────▶  │     broker          │
│                 │                   │                     │
│  RealtimeProvider                   │  reads JWT claims   │
│   ↓ refresh token                   │  applies RLS to     │
│  /api/auth/      ◀──HTTP HS256 JWT─ │  postgres_changes   │
│   realtime-token │                  │  filtered events    │
│                 │                   └─────────┬───────────┘
│  useTableSubsc  │                             │ replication
│  ription hook   │                   ┌─────────▼───────────┐
└─────────────────┘                   │  Postgres (Supabase)│
                                      │   publication:      │
                                      │   supabase_realtime │
                                      └─────────────────────┘
```

## Components

### Postgres
- **Publication** `supabase_realtime` — Phase 12B added the seven entity
  tables: `leads`, `crm_accounts`, `contacts`, `opportunities`, `tasks`,
  `activities`, `notifications`. `REPLICA IDENTITY FULL` is set so
  UPDATE/DELETE payloads include the OLD row (skip-self + animation).
- **RLS policies (`SELECT … TO authenticated`)** — also Phase 12B. Each
  policy reads `request.jwt.claims` via three helpers that live in
  `public` (the Management API role can't write to the `auth` schema):
  - `public.mwg_jwt_user_id()`
  - `public.mwg_jwt_is_admin()`
  - `public.mwg_jwt_can_view_all()`
  The policies enforce visibility identical to the app layer:
  owner-or-admin for leads/accounts/contacts/opportunities; creator-or-
  assignee for tasks; author-or-parent-owner for activities; recipient-
  only for notifications.

### Auth bridge
- **`/api/auth/realtime-token`** mints HS256 JWTs signed with
  `SUPABASE_JWT_SECRET`. Claims: `sub`, `role: "authenticated"`,
  `is_admin`, `can_view_all_records`, `email`. TTL 1 hour. Rate limited
  per process to 30 mints/minute/user.
- The CRM does **not** use Supabase Auth — Auth.js is the source of
  truth. The realtime JWT is purely a transient credential for the
  Realtime broker to evaluate RLS. The user re-fetch inside the mint
  endpoint ensures permission revocation propagates within ≤1 hour.

### Server-side database access
- All server-side reads / writes continue through Drizzle + postgres-js
  using the `mwg_crm_app` role with `BYPASSRLS`. The new RLS policies
  do not affect server-side traffic.

### Client
- **`<RealtimeProvider userId={...}>`** mounted in `(app)/layout.tsx`.
  Fetches a token, hands it to the realtime client via
  `client.realtime.setAuth(token)`, refreshes 5 min before expiry, with
  30s backoff on failure. Provides `userId` to descendants for skip-self.
- **`useTableSubscription({ table, filter, onChange })`** subscribes to
  `postgres_changes` on `public.<table>` (optionally filtered by a
  `column=eq.value`). Skip-self compares the incoming actor stamp
  (`updated_by_id` / `created_by_id` / `user_id`) to the current
  viewer's id and short-circuits self-echo. Cleans up on unmount.
- **`useRowSubscription({ table, id, onChange })`** is a thin wrapper
  for detail-page single-row subscription.
- **`<PageRealtime entities={[…]} />`** is the simple drop-in for list
  pages: subscribes and calls `router.refresh()` on any change, debounced
  150ms. Phase 11's `<PagePoll>` continues as the polling fallback.

## Skip-self mechanism

The realtime broker delivers a row's INSERT/UPDATE/DELETE event to
*every* subscribed client whose RLS allows them to see that row —
including the actor's own client. To prevent self-echo, the hook
inspects the row's actor stamp:

| Table | Actor column |
|---|---|
| `leads` | `updated_by_id` (UPDATE) / `created_by_id` (INSERT) |
| `crm_accounts`, `contacts`, `opportunities`, `tasks` | same — Phase 12B added `updated_by_id` |
| `activities` | `user_id` |
| `notifications` | n/a — recipient-only by RLS, fan-out is intentional |

Sub-A's job in Phase 12C is to make sure every server action stamps the
appropriate actor column on every UPDATE.

### Test escape hatch

In Playwright runs the lone test account (`REDACTED-EMAIL`) acts
in two contexts at once. Skip-self would filter both. The hook honors
`localStorage._e2eDisableSkipSelf === "true"` to bypass the check.
Sub-C's `realtime.spec.ts` sets this flag before subscribing.

## Failure modes

| Failure | Behavior |
|---|---|
| `NEXT_PUBLIC_SUPABASE_*` missing | `getRealtimeClient()` returns null; hooks no-op; PagePoll polling layer continues |
| `SUPABASE_JWT_SECRET` missing | mint endpoint returns 503 `realtime-disabled`; provider retries every 30s |
| Mint endpoint 401 | provider stops trying; next nav redirects to /auth/signin |
| Realtime websocket drop | `@supabase/supabase-js` auto-reconnects; on extended outage the polling layer keeps data fresh |
| Permission revoked mid-session | next token refresh (≤1 hour) returns the updated `is_admin` / `can_view_all_records`; the broker then stops delivering rows the user can't see |

## Observability

- Mint successes log `realtime.token.minted` at debug level.
- Provider failures `console.warn("[realtime] token refresh failed; retrying", err)` with the underlying error.
- For deeper diagnostics, enable Supabase project's Realtime logs
  (Project → Logs → Realtime).
