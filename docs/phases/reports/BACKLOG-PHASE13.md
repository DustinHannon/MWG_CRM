# Backlog — Phase 13

> Findings discovered during the Phase 12 review that exceed the
> ~50-line / few-files heuristic. Each entry has reproduction +
> impact so a future engineer can act on it without re-investigating.

## P13-001 — Theme drift: 127 raw Tailwind palette literals across 40 files

**Source:** Sub-A audit (Phase 12C, 2026-05-08)

**Repro:**
```bash
grep -rEn "\\b(?:bg|text|border)-(?:red|orange|yellow|green|blue|indigo|purple|pink|rose|cyan|teal|emerald|sky|violet|fuchsia|lime|amber)-[0-9]{2,3}\\b" src/
```

127 hits in 40 files. Highest-density offenders:
- `src/app/(app)/leads/page.tsx` — 16 hits (Pill palette)
- `src/app/(app)/leads/import/import-client.tsx` — 12 hits
- `src/app/admin/users/[id]/delete-user.tsx` — 9 hits
- `src/components/leads/duplicate-warning.tsx` — 9 hits

**Impact:** Light/dark theme drift — these literal palette references
encode their own dark-variant pair (`dark:bg-blue-500/15`) rather than
reading from the `:root` / `.dark` token surface in
`src/app/globals.css`. Adding a future "theme=high-contrast" or
rotating brand color requires 127 manual swaps.

**Recommendation:** introduce semantic tokens for the 6 status-pill
shapes, the 3 priority-pill shapes, and the 4 source-pill shapes (the
canonical Pill components in `leads/page.tsx`). Then sweep the
remaining ~75 standalone uses (decorative blobs on signin, danger
zones in admin/data, etc.) and decide per-file: replace with token,
or accept as decorative-only.

Estimated: 2-3 days of careful refactor + visual diff. Would touch
40 files. Larger than the 50-line / few-file Sub-A bar.

## P13-002 — `convertLead` UX polish: confirm guard before duplicate-submit

**Source:** Sub-A audit (Phase 12C, 2026-05-08), referenced in
PHASE12-BUGS.md BUG-008.

The convert modal already disables the submit button via
`useTransition` (`disabled={pending || !accountName.trim()}`), so a
double-click can't fire two requests. **However**, navigating away
mid-transition and clicking back resets the modal state. A theoretical
race exists if Network is throttled and a user reopens the modal
during the same tab session.

**Recommendation:** persist a per-lead "conversion in progress" flag
in `localStorage` keyed on `lead.id` and clear on completion. <50
lines. Polish, not safety — server tx already prevents double-conv.

## P13-003 — Hover-only delete affordance on list rows

**Source:** Sub-A audit (Phase 12C, 2026-05-08), PHASE12-BUGS BUG-004.

`group-hover:opacity-100` on lead/account/contact/opportunity row
trash icons is invisible on `(hover: none)` devices (touch). Sub-B's
mobile pass owns this via `@media (hover: hover)` overrides; this is
listed for visibility in case Sub-B defers.

## P13-004 — `archiveLeadsById` and sister archives don't audit-log per row

**Source:** Sub-A audit (Phase 12C).

The archive helpers take `ids: string[]` but `writeAudit` is called
once at the action layer with one targetId. Bulk archive (none in
production today, but admin tools could) would lose per-row audit
attribution. Defer until bulk-archive UI exists.


## P13-001a — Pre-auth pages still hold 6 raw palette literals

**Source:** Sub-D follow-up (Phase 12D, 2026-05-08).

Phase 12 Sub-D took the `P13-001` baseline from 114 raw palette
literals down to 6, all clustered in pre-authentication chrome:

- `src/app/auth/disabled/page.tsx:3` — `bg-slate-950` page bg
- `src/app/auth/signin/page.tsx:47` — `bg-slate-950` page bg
- `src/app/auth/signin/page.tsx:49` — `bg-blue-500/20` decorative blob
- `src/app/auth/signin/page.tsx:50` — `bg-indigo-500/15` decorative blob
- `src/app/auth/signin/microsoft-button.tsx:22` — `bg-white/95 text-slate-900`
- `src/app/auth/signin/signin-form.tsx:99` — `bg-white/90 text-slate-900`

These render before next-themes mounts and are intentionally
locked to a dark glass aesthetic regardless of the user's theme
preference. Tokenizing them would require either:
  1. Two new "auth-only" semantic tokens (e.g.
     `--auth-page-bg`, `--auth-cta-fg`) that ignore the `.dark`
     toggle — clean but adds tokens for ≤2 surfaces.
  2. Locking the `<body>` of `(auth)` routes to `class="dark"`
     unconditionally and re-using `bg-background` etc. — needs a
     route-segment layout audit.

**Recommendation:** option 2 in Phase 13. Until then the 6 hits
stay literal — they will not drift because the auth pages own
their own visual language.
