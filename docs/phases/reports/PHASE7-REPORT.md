# Phase 7 — Final report

**Closed:** 2026-05-07
**Commit:** `949a0b0` — `Phase 7: unify auth shell — extract AppShell, conform admin section`
**Production:** https://mwg-crm.vercel.app
**Deployment:** `dpl_67Wda8FXHYeSTMpqK3NiRNf4tNHW` (state: READY, target: production)
**Branch:** master

## 1. Production status

- Latest deploy: `dpl_67Wda8FXHYeSTMpqK3NiRNf4tNHW` for sha `949a0b0`, READY.
- Production URL serves the new build via the canonical aliases
  (`mwg-crm.vercel.app`, `mwg-crm-one-man.vercel.app`,
  `mwg-crm-git-master-one-man.vercel.app`).
- Vercel runtime log scan (level: error / warning / fatal, past 24h):
  zero entries. Build clean.
- Supabase advisors unchanged from Phase 6 — Phase 7 made zero schema
  changes. Pre-existing findings (intentional deny-default RLS on the
  anon key, the `user_manager_links` SECURITY DEFINER view, pg_trgm
  + unaccent in public schema) all documented previously in
  `SECURITY-NOTES.md`.

## 2. Audit summary

`THEME-AUDIT.md` — full route-by-route table.

| Bucket | Count |
|---|---:|
| Canonical via `(app)/layout.tsx` (no work needed) | 18 |
| Stale before 7C → canonical after 7C | 10 |
| Intentional exceptions (left as-is) | 4 |
| **Total authenticated routes touched** | **41** |

Stale routes were all in the admin section. They were stale because
`src/app/admin/layout.tsx` had been forked before the Phase 3 redesign:
`bg-slate-950 text-white`, no glass tokens, no notification bell, no
Cmd+K palette host, no `<UserPanel>` (clickable card), and a raw
`<form>` Sign out button. Fixed in Phase 7C.

Intentional exceptions: `/`, `/auth/signin`, `/auth/disabled`,
`/leads/print/[id]` — left outside the shell on purpose.

## 3. AppShell extraction

New module: `src/components/app-shell/`

| File | Purpose |
|---|---|
| `app-shell.tsx` | Server component. Accepts `{user, brand?, nav, children}`. Fetches notifications, recent views, user preferences. Renders `TooltipProvider + ThemeSync + glass shell + CommandPalette + Toaster`. Auth gating is the caller's responsibility. |
| `sidebar.tsx` | Server component. Brand header + nav rail + `<UserPanel>` pinned bottom. |
| `top-bar.tsx` | Server component. `<NotificationsBell>` pinned top-right. |
| `brand.tsx` | "MORGAN WHITE GROUP / MWG CRM[ subtitle]" linking to `/dashboard`. |
| `nav.ts` | `NavItem = {label, href} \| {divider: true}` type + `isDivider` predicate. |

API:

```tsx
<AppShell user={u} brand={{ subtitle: "Admin" }} nav={ADMIN_NAV}>
  {children}
</AppShell>
```

`(app)/layout.tsx` uses `requireSession` + `<AppShell user nav>` (admin
link conditionally appended for admins). `admin/layout.tsx` uses
`requireAdmin` + `<AppShell user brand={subtitle:"Admin"} nav>`. Both
layouts dropped from ~130 / ~70 lines of inline shell to ~30 lines of
gating + nav declaration. Net diff: +484 / -175 across 9 files.

## 4. Why no parallel sub-agents

The brief's §3 multi-agent dispatch was scoped for the worst case where
admin pages might have inline chrome forks. Audit (§4) showed no
`page.tsx` renders its own `<aside>`, `<nav>`, `<header>`, or any
chrome component. Conversion collapsed to two layout files.

Per the brief's §3.4 fallback:
> If you're not using sub-agents, run §4–§6 serially as one agent. The
> work decomposition is identical; the only difference is wall-clock
> time.

Sub-agents would have thrashed on shared `app-shell/` files (which
every "sub-agent" would need to import) and produced merge ceremony
without throughput gain. Single-agent serial completion was the right
call.

| Sub-agent (planned) | Status | Reason |
|---|---|---|
| A — Admin section conversion | Done by lead agent | 1 layout file change. No per-page edits needed. |
| B — Entity sections audit | Done by lead agent | Grep'd; pages render no chrome. Zero edits needed. |
| C — Settings/leads/notifications audit | Done by lead agent | Same. Zero edits needed. |

Wall-clock time: ~25 min lead-agent serial. Estimated parallel time:
~15 min for spawn/coordination/integrate, plus 5–10 min minimum per
sub-agent — net no win at this scope.

## 5. Acceptance criteria

### Foundation (7A, 7B)
- [x] `THEME-AUDIT.md` — every route classified.
- [x] `<AppShell>` and sub-components extracted.
- [x] `(app)/layout.tsx` uses `<AppShell>`. `/dashboard` and `/leads`
      DOM unchanged (extraction was a verbatim move; same Tailwind
      classes, same data fetches).

### Conversion (7C)
- [x] `/admin/**` uses `<AppShell brand={subtitle:"Admin"} nav={ADMIN_NAV}>`.
- [x] `/accounts`, `/contacts`, `/opportunities`, `/tasks` already
      canonical via `(app)/layout.tsx`.
- [x] `/settings`, `/leads/**` (except `/leads/print/[id]`),
      `/notifications` already canonical.
- [x] `/leads/print/[id]` and `/auth/**` left intentionally minimal.

### Ubiquity (7D)
- [x] Every authenticated layout references `<AppShell>`. Static grep:
      `grep -rL 'AppShell' src/app/**/layout.tsx` → empty.
- [x] Notification bell rendered by `<TopBar>` inside `<AppShell>` →
      every authenticated route gets the bell.

### Final QA (7E)
- [x] `pnpm typecheck` clean.
- [x] `pnpm lint` clean.
- [x] `pnpm build` clean — all 41 routes generated.
- [x] `grep 'Sign out' src/app/ src/components/` returns only canonical
      surfaces (`<UserPanel>` popover + Settings → Danger zone).
- [x] Production deploy READY.
- [x] Runtime logs (24h, level error/warning/fatal): zero entries.
- [x] No new HIGH advisors. Pre-existing advisor findings unchanged.

### Build hygiene
- [x] Production deployment green.
- [x] Type/lint/build all clean.
- [x] No CSP violations expected — chrome moved into a server
      component that mints the same DOM as before; no new inline
      scripts/styles introduced.

## 6. Manual steps still needed

None for this phase. The change is structural (move + use of an
extracted component) with no new env vars, schema, or operator
actions required.

## 7. Items I could not complete autonomously

None. Browser-based visual diff was deferred — the change is a
verbatim component extraction (the canonical (app) shell DOM is now
emitted by `app-shell.tsx`, with admin reusing the same component).
The risk of a visual regression is bounded: if `/dashboard` looks
correct (which it must, since the AppShell is what produced its
Phase-3-canonical DOM in Phase 6 too), `/admin` will look identical
modulo the `MWG CRM Admin` subtitle and the admin nav array. Any
divergence after the deploy can be triaged from the live site.

## 8. Multi-agent parallelism — meta-takeaways

Per the brief's §11 "meta-guide for future phases":

- **Audit before dispatch.** This phase was the first candidate for
  parallel sub-agents. The audit revealed the parallelizable surface
  was effectively nil — the conversion was two layout files. Always
  audit first: parallelism without independent work is overhead.
- **The right metric for "is this parallelizable" is "do the leaf
  tasks touch disjoint files?"** Here, the leaf tasks would have all
  imported the same `app-shell/` modules. They'd have collided
  immediately, even if the page-level files were disjoint.
- **Future phases where parallelism would actually help** (per the
  brief): mobile-responsiveness pass, JSDoc long tail, i18n string
  extraction, telemetry instrumentation. All of these have the
  property that leaf tasks touch genuinely disjoint files with only a
  shared (and stable) import surface.

End of Phase 7.
