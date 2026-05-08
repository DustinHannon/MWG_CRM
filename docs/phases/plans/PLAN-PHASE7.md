# Phase 7 — Visual & shell consistency

**Date:** 2026-05-07
**Branch:** master (push direct, autodeploy)
**Pre-req:** Phase 6 shipped (commits e73389e..2857542). Working tree clean.

## Goal

One canonical authenticated shell used by every protected route. The
admin section currently uses a fork of the layout that predates Phase
3's redesign — no glass tokens, no notification bell, no clickable user
panel, no Cmd+K (well, Cmd+K is global, but the chrome it lives in is
stale). Conform admin to canonical without redesigning anything.

## Audit summary (Phase 7A — already complete)

`grep`'d every page for chrome rendering. Findings:
- **No `page.tsx` renders its own** `<aside>`, `<nav>`, `<header>`, or
  `<NotificationsBell>/<CommandPalette>/<UserPanel>/<ThemeSync>/<Toaster>/<TooltipProvider>`.
  Pages are pure content. So conversion reduces to **layout files only**.
- The only stale "Sign out" UI is `src/app/admin/layout.tsx` (raw form
  + plain-text button). The canonical Sign out flow lives in
  `<UserPanel>` popover and the Settings → Danger zone.
- Routes split into three layout buckets:
  - **Canonical** (`(app)/layout.tsx`): dashboard, leads/**,
    accounts/**, contacts/**, opportunities/**, tasks, settings,
    notifications.
  - **Stale** (`admin/layout.tsx`): admin, admin/users/**, admin/tags,
    admin/scoring/**, admin/audit, admin/data, admin/settings,
    admin/import-help.
  - **Intentional exceptions** (root or different layout): `/`
    redirect, `auth/signin`, `auth/disabled`, `leads/print/[id]`.

## Why no parallel sub-agents

The brief's §3 multi-agent dispatch was scoped for the worst case where
admin pages might have inline chrome forks needing per-file conversion.
Audit shows they don't. The conversion is two layout files. Per §3.4,
running serially is identical work for less ceremony. Sub-agents would
just thrash on shared `app-shell/` files. Documented in PHASE7-REPORT.md.

## Phases

### 7A — Audit (DONE during planning)

Output: `THEME-AUDIT.md` (this commit).

### 7B — Extract canonical AppShell (serial)

New components under `src/components/app-shell/`:

- `app-shell.tsx` — server component. Accepts `{user, brand?, nav, children}`.
  Fetches notifications/recent-views/preferences. Renders
  `<TooltipProvider><ThemeSync/><div flex><Sidebar/><main><TopBar/>{children}</main></div><CommandPalette/><Toaster/></TooltipProvider>`.
- `sidebar.tsx` — server component. Brand header + nav rail + UserPanel.
- `top-bar.tsx` — server component. NotificationsBell pinned top-right.
- `brand.tsx` — server component. "MORGAN WHITE GROUP / MWG CRM
  [subtitle]" linking to /dashboard.
- `nav.ts` — types for `NavItem` (`{label, href, show?}` or `{divider: true}`)
  and `APP_NAV` (default app nav array, with admin-conditional tail).

Auth gating stays in each layout — `(app)/layout.tsx` calls
`requireSession`, `admin/layout.tsx` calls `requireAdmin`. Both pass
the resolved `SessionUser` to `<AppShell>`. AppShell never gates auth
itself; it's a pure renderer.

Smoke test: `(app)/layout.tsx` rewritten to use `<AppShell>`.
`/dashboard` and `/leads` look identical to before extraction.

### 7C — Convert admin layout (serial)

`admin/layout.tsx` rewritten:

```tsx
const ADMIN_NAV: NavItem[] = [
  { label: "Overview", href: "/admin" },
  { label: "Users", href: "/admin/users" },
  { label: "Tags", href: "/admin/tags" },
  { label: "Scoring", href: "/admin/scoring" },
  { label: "Audit log", href: "/admin/audit" },
  { label: "Data tools", href: "/admin/data" },
  { label: "Import help", href: "/admin/import-help" },
  { label: "Settings", href: "/admin/settings" },
  { divider: true },
  { label: "← Back to dashboard", href: "/dashboard" },
];

export default async function AdminLayout({ children }) {
  const user = await requireAdmin();
  return (
    <AppShell user={user} brand={{ subtitle: "Admin" }} nav={ADMIN_NAV}>
      {children}
    </AppShell>
  );
}
```

Old `bg-slate-950 text-white` shell, raw form Sign out, and inline
`<aside>/<nav>/<SidebarLink>` are deleted. Same component + glass
tokens as the rest of the app. Subtitle "Admin" preserves the
"MWG CRM Admin" identity.

### 7D — Bell + chrome ubiquity (serial)

- `grep -rL 'AppShell' src/app/**/layout.tsx` (modulo intentional) →
  empty.
- Manual: visit /dashboard, /leads, /admin, /admin/users, /admin/audit,
  /settings, /accounts in light + dark on production. Bell present, user
  panel present, glass background present.

### 7E — Final QA + report (serial)

- `pnpm typecheck && pnpm lint && pnpm build`. Clean.
- Vercel deploy green.
- `grep -rn 'Sign out' src/app/` — only canonical surfaces remain.
- Update `THEME-AUDIT.md` to flag every previously-stale route as
  canonical.
- `PHASE7-REPORT.md` summarising changes.

## Forbidden zones

- `src/db/**`, `src/lib/**`, schemas, migrations — out of scope.
- `auth/*` and `leads/print/[id]` — intentionally minimal, do not touch.
- No new features. No design changes. Conform, don't redesign.

## Rollback plan

If a regression slips through, `git revert` the AppShell-extraction
commit. The pre-Phase-7 admin shell still exists in master history
under commit 2857542.
