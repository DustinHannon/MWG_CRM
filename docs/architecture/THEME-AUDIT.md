# Phase 7 Theme / Shell Audit

**Audited:** 2026-05-07 (initial pass)
**Closed:** 2026-05-07 after Phase 7B + 7C committed (commit 949a0b0)
**Method:** Enumerated all `src/app/**/{page,layout}.tsx`, then
`grep`'d every page for chrome elements (`<aside>`, `<nav>`, `<header>`)
and chrome components (`<NotificationsBell>`, `<CommandPalette>`,
`<UserPanel>`, `<ThemeSync>`, `<Toaster>`, `<TooltipProvider>`).

**Headline:** No `page.tsx` rendered its own chrome. Conversion problem
collapsed to **two layout files**: `(app)/layout.tsx` (canonical) and
`admin/layout.tsx` (stale fork from before the Phase 3 redesign).
Both now wrap `<AppShell>`. Every authenticated route shares the same
chrome.

## Layout files — final state

| Layout | Canonical shell | Notes |
|---|---|---|
| `src/app/layout.tsx` | n/a — root html/body wrapper | Mounts `<ThemeProvider>` for next-themes. Correct, untouched. |
| `src/app/(app)/layout.tsx` | ✅ canonical | Thin wrapper — `requireSession` → `<AppShell user nav>`. Admin link conditionally appended. |
| `src/app/admin/layout.tsx` | ✅ canonical | Thin wrapper — `requireAdmin` → `<AppShell user brand={subtitle:"Admin"} nav>`. |

Both layouts now import from `src/components/app-shell/`. Glass
tokens, notification bell, Cmd+K palette, clickable UserPanel, theme
sync, and toaster are uniform across both layouts because they're
literally rendered by the same component.

## Routes — final status

### Canonical via `(app)/layout.tsx` → AppShell

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

### Canonical via `admin/layout.tsx` → AppShell (subtitle="Admin")

| Route | Before 7C | After 7C |
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
| `/` (root `page.tsx`) | Redirect to `/dashboard` or sign-in. No UI. |
| `/auth/signin` | Sign-in flow, deliberately minimal. |
| `/auth/disabled` | Disabled-account terminal page, deliberately minimal. |
| `/leads/print/[id]` | Print-only PDF export layout. Must stay minimal. |

## Stale-UI scan — final

`grep -rn 'Sign out\|signOut' src/app/ src/components/` after 7C:

| File | Status | Notes |
|---|---|---|
| `(app)/settings/_components/danger-zone-section.tsx` | ✅ canonical | Settings → Danger zone. Allowed. |
| `(app)/settings/actions.ts` | ✅ canonical | Server action backing the Danger zone. |
| `components/user-panel/user-panel.tsx` | ✅ canonical | UserPanel popover Sign out. The canonical surface. |

`admin/layout.tsx` no longer matches `Sign out` — the old form was
deleted with the layout rewrite.

## Chrome-component reuse — final

Every chrome component is imported by exactly one consumer:

| Component | Imported by |
|---|---|
| `<NotificationsBell>` | `app-shell/top-bar.tsx` |
| `<CommandPalette>` | `app-shell/app-shell.tsx` |
| `<UserPanel>` | `app-shell/sidebar.tsx` |
| `<ThemeSync>` | `app-shell/app-shell.tsx` |
| `<Toaster>` | `app-shell/app-shell.tsx` |
| `<TooltipProvider>` | `app-shell/app-shell.tsx` |
| `<ThemeProvider>` | `src/app/layout.tsx` (root, unchanged) |

No layout or page imports these directly. AppShell is the single
mounting point.

## Closing state

After Phase 7B + 7C:
- Every authenticated route renders the same chrome via `<AppShell>`.
- Admin section gets the glass aesthetic, bell, Cmd+K palette host,
  and clickable UserPanel — identical look to `/dashboard` apart from
  the brand subtitle ("MWG CRM Admin") and the admin-specific nav
  array.
- The admin nav (Overview, Users, Tags, Scoring, Audit log, Data
  tools, Import help, Settings, divider, Back to dashboard) is
  preserved.
- Root, auth, and print routes intentionally remain outside the shell.
- No regressions to canonical pages — extraction was a verbatim move
  of the existing inline shell from `(app)/layout.tsx` into
  `app-shell/` modules; same DOM, same Tailwind classes, same data
  fetches.
