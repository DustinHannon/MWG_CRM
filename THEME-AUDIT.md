# Phase 7 Theme / Shell Audit

**Audited:** 2026-05-07
**Method:** Enumerated all `src/app/**/{page,layout}.tsx`, then
`grep`'d every page for chrome elements (`<aside>`, `<nav>`, `<header>`)
and chrome components (`<NotificationsBell>`, `<CommandPalette>`,
`<UserPanel>`, `<ThemeSync>`, `<Toaster>`, `<TooltipProvider>`).

**Headline:** No `page.tsx` renders its own chrome. Conversion problem
reduces to **two layout files**: `(app)/layout.tsx` (canonical) and
`admin/layout.tsx` (stale).

## Layout files

| Layout | Canonical shell | Notes |
|---|---|---|
| `src/app/layout.tsx` | n/a — root html/body wrapper | Mounts `<ThemeProvider>` for next-themes. Correct. |
| `src/app/(app)/layout.tsx` | ✅ canonical | TooltipProvider + ThemeSync + glass sidebar w/ UserPanel + bell + CommandPalette + Toaster. After 7B: thin wrapper around `<AppShell>`. |
| `src/app/admin/layout.tsx` | ❌ stale → ✅ after 7C | Currently `bg-slate-950`, no glass, no bell, no palette, raw Sign out form. Phase 7C converts. |

## Routes by status

### Canonical via `(app)/layout.tsx` — no work needed

| Route | Status |
|---|---|
| /dashboard | canonical |
| /leads | canonical |
| /leads/[id] | canonical |
| /leads/[id]/edit | canonical |
| /leads/new | canonical |
| /leads/import | canonical |
| /leads/archived | canonical |
| /leads/pipeline | canonical |
| /accounts | canonical |
| /accounts/[id] | canonical |
| /contacts | canonical |
| /contacts/[id] | canonical |
| /opportunities | canonical |
| /opportunities/[id] | canonical |
| /opportunities/pipeline | canonical |
| /tasks | canonical |
| /settings | canonical |
| /notifications | canonical |

### Stale → conformed in Phase 7C

| Route | Status before | Status after 7C |
|---|---|---|
| /admin | stale | canonical |
| /admin/users | stale | canonical |
| /admin/users/[id] | stale | canonical |
| /admin/tags | stale | canonical |
| /admin/scoring | stale | canonical |
| /admin/scoring/help | stale | canonical |
| /admin/audit | stale | canonical |
| /admin/data | stale | canonical |
| /admin/import-help | stale | canonical |
| /admin/settings | stale | canonical |

### Intentional exceptions — left as-is

| Route | Why |
|---|---|
| `/` (root `page.tsx`) | Redirect to `/dashboard` or `/auth/signin`. No UI. |
| `/auth/signin` | Sign-in flow, deliberately minimal. |
| `/auth/disabled` | Disabled-account terminal page, deliberately minimal. |
| `/leads/print/[id]` | Print-only PDF export layout. Must stay minimal. |

## Stale-UI scan

`grep 'Sign out\|signOut' src/app/`:

| File | Status | Notes |
|---|---|---|
| `admin/layout.tsx` | ❌ stale → fixed in 7C | Raw form + button. Removed when migrating to AppShell. |
| `(app)/layout.tsx` | ✅ canonical | Indirect via `<UserPanel>`. |
| `(app)/settings/_components/danger-zone-section.tsx` | ✅ canonical | Settings → Danger zone Sign-out-all-sessions. Allowed. |
| `(app)/settings/actions.ts` | ✅ canonical | Server action backing the Danger zone. |
| `auth.ts` | ✅ canonical | NextAuth library. |
| `components/user-panel/user-panel.tsx` | ✅ canonical | The new UserPanel popover Sign out. |

After Phase 7C, the only Sign-out UI surfaces are `<UserPanel>` popover
and the Settings Danger zone.

## Chrome-component reuse audit

- `<NotificationsBell>` imported only in `(app)/layout.tsx`. After 7B,
  imported in `app-shell/top-bar.tsx`. Admin gets it via AppShell.
- `<CommandPalette>` imported only in `(app)/layout.tsx`. After 7B,
  imported in `app-shell/app-shell.tsx`.
- `<UserPanel>` imported only in `(app)/layout.tsx`. After 7B, imported
  in `app-shell/sidebar.tsx`.
- `<ThemeSync>` imported only in `(app)/layout.tsx`. After 7B, imported
  in `app-shell/app-shell.tsx`.
- Root `layout.tsx` mounts `<ThemeProvider>` — correct, unchanged.

## Closing state

After Phase 7B + 7C:
- Every authenticated route renders the same chrome via `<AppShell>`.
- Admin section gets the glass aesthetic, bell, Cmd+K trigger, and the
  clickable UserPanel — same look as `/dashboard`.
- The "MWG CRM Admin" identity is preserved as `subtitle="Admin"` on
  the Brand header.
- Root, auth, and print routes remain intentionally minimal.

This file is rewritten in Phase 7E to flag every previously-stale row
as canonical and add an "after" column with deploy verification.
