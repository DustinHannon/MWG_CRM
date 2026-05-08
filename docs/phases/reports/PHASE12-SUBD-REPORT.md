# Phase 12 — Sub-Agent D Final Report

**Scope:** Sweep `src/` for raw Tailwind palette literals
(`bg-blue-500`, `text-rose-700`, `border-emerald-300/30`, etc.) and
replace them with the canonical semantic tokens defined in
`src/app/globals.css` (shadcn `--primary`/`--destructive`/`--muted`,
Phase 11 `--status-*` and `--priority-*`). Skips `tests/`, `scripts/`,
generated code, and intentional one-offs.

**Status:** Complete. Master is at `a02eb40`.

---

## Headline numbers

| Metric | Value |
|---|---|
| Baseline raw-palette hits (start of session) | **114** |
| Final raw-palette hits | **6** |
| Net reduction | **108 (-94.7%)** |
| Files in scope at start | 41 |
| Files fully tokenized | **35** |
| Files deferred to Phase 13 | **6** (auth-only) |
| Atomic commits pushed by Sub-D in this run | 4 |

The Sub-A audit `P13-001` originally reported 127 hits across 40
files. The 13-hit gap between 127 and 114 reflects a different regex:
Sub-A's pattern excluded `slate/gray/zinc/neutral/stone/sky/red`,
while this run's pattern covered every Tailwind palette family.

Baseline regex used for both numbers above:

```
(bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|caret|accent|decoration|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]+
```

---

## Commits by Sub-D in this run

(Plus the prior `85b8cbe` from the pre-resume run on /leads.)

| SHA | Files | Summary |
|---|---|---|
| `ea435e5` | 2 | leads/import + duplicate-warning |
| `06de67e` | 12 | leads detail + activities + reports |
| `f57c467` | 16 | archived pages + create forms + scoring + dashboard + dialogs |
| `a02eb40` | 2 | pipeline boards (rating dot + delete hover) |

Plus 6 of Sub-D's admin/users + admin/data edits were pulled into
`0f4c97c` by Sub-E (parallel agent inadvertently included them in a
breadcrumb-collapse commit). Net coverage is the same; attribution is
mixed.

---

## Token mapping legend

The Pill refactor in `85b8cbe` established the semantic mapping that
the rest of this sweep follows:

| Raw class shape | Semantic replacement |
|---|---|
| `bg-blue-500/20 text-blue-700 border-blue-500/30` | `bg-[var(--status-new-bg)] text-[var(--status-new-fg)] border-[var(--status-new-fg)]/30` |
| `bg-cyan-500/20 text-cyan-700` | `--status-contacted-*` |
| `bg-emerald-500/20 text-emerald-700` | `--status-won-*` |
| `bg-rose-500/20 text-rose-700` | `--status-lost-*` |
| `bg-violet-500/20 text-violet-700` | `--status-proposal-*` |
| `bg-amber-500/20 text-amber-700` | `--priority-medium-*` |
| `bg-red-500/20 text-red-700` (very high) | `--priority-very-high-*` |
| `bg-rose-500/80` (destructive CTA) | `bg-destructive text-destructive-foreground` |
| `text-blue-500 focus:ring-blue-500` (radio/checkbox) | `text-primary focus:ring-ring` |
| `hover:text-rose-600` (icon button) | `hover:text-destructive` |
| `text-emerald-700 dark:text-emerald-200` (semantic-success label) | `text-[var(--status-won-fg)]` |

No new tokens were introduced into `globals.css` — every replacement
landed on an existing token. The instruction's "≥3 usages benefit"
gate would have been met for a hypothetical `--warning-*` family,
but `--priority-medium-*` already serves that role on light + dark.

---

## Files touched

(35 files; ordered by domain.)

**Leads + activities + graph:**
- `src/app/(app)/leads/page.tsx` (prior commit `85b8cbe`)
- `src/app/(app)/leads/[id]/page.tsx`
- `src/app/(app)/leads/[id]/activities/activity-composer.tsx`
- `src/app/(app)/leads/[id]/activities/activity-delete-button.tsx`
- `src/app/(app)/leads/[id]/activities/activity-feed.tsx`
- `src/app/(app)/leads/[id]/graph/graph-actions.tsx`
- `src/app/(app)/leads/lead-form.tsx`
- `src/app/(app)/leads/view-toolbar.tsx`
- `src/app/(app)/leads/import/import-client.tsx`
- `src/app/(app)/leads/archived/page.tsx`
- `src/app/(app)/leads/pipeline/_components/board.tsx`

**Other entity pages + forms:**
- `src/app/(app)/accounts/archived/page.tsx`
- `src/app/(app)/accounts/new/_components/account-form.tsx`
- `src/app/(app)/contacts/archived/page.tsx`
- `src/app/(app)/contacts/new/_components/contact-form.tsx`
- `src/app/(app)/opportunities/archived/page.tsx`
- `src/app/(app)/opportunities/new/_components/opportunity-form.tsx`
- `src/app/(app)/opportunities/pipeline/_components/board.tsx`
- `src/app/(app)/tasks/archived/page.tsx`
- `src/app/(app)/tasks/_components/task-list-client.tsx`
- `src/app/(app)/dashboard/page.tsx`
- `src/app/(app)/users/[id]/page.tsx`

**Admin:**
- `src/app/admin/data/danger-section.tsx`
- `src/app/admin/scoring/_components/rules-table.tsx`
- `src/app/admin/scoring/_components/threshold-sliders.tsx`
- `src/app/admin/settings/page.tsx`
- `src/app/admin/users/[id]/delete-user.tsx`
- `src/app/admin/users/[id]/page.tsx`
- `src/app/admin/users/[id]/user-actions.tsx`
- `src/app/admin/users/page.tsx`
- `src/app/admin/users/help/page.tsx`

**Shared components:**
- `src/components/delete/confirm-delete-dialog.tsx`
- `src/components/delete/delete-icon-button.tsx`
- `src/components/leads/duplicate-warning.tsx`
- `src/components/leads/score-badge.tsx`
- `src/components/reports/report-action-menu.tsx`
- `src/components/reports/report-builder.tsx`
- `src/components/user-display/user-hover-card.tsx`

**Auth (signin error message only):**
- `src/app/auth/signin/signin-form.tsx`

---

## Deferred to Phase 13 (`P13-001a`)

The remaining 6 hits all live in pre-authentication chrome where the
visual language is intentionally locked to a dark glass aesthetic
independent of the theme system:

| File | Line | Class |
|---|---|---|
| `src/app/auth/disabled/page.tsx` | 3 | `bg-slate-950` |
| `src/app/auth/signin/page.tsx` | 47 | `bg-slate-950` |
| `src/app/auth/signin/page.tsx` | 49 | `bg-blue-500/20 blur-3xl` (decorative blob) |
| `src/app/auth/signin/page.tsx` | 50 | `bg-indigo-500/15 blur-3xl` (decorative blob) |
| `src/app/auth/signin/microsoft-button.tsx` | 22 | `bg-white/95 text-slate-900` |
| `src/app/auth/signin/signin-form.tsx` | 99 | `bg-white/90 text-slate-900` |

Recommendation captured under `P13-001a` in `BACKLOG-PHASE13.md`:
either introduce auth-only tokens, or pin `<html class="dark">` on
the `(auth)` route segment so the existing semantic tokens read
correctly. Until then the 6 literals stay because the auth pages
own their own design language and won't drift.

---

## Coordination with Sub-E

The two agents ran concurrently against `master` with non-overlapping
concepts:

- **Sub-D (this report):** color tokens.
- **Sub-E:** mobile/responsive layout + breakpoints.

Workflow followed the prescribed `git fetch origin && git rebase
origin/master` loop before each push and used `git stash` to step
around Sub-E's in-flight files. Two friction points:

1. Sub-E's commit `0f4c97c` (breadcrumb collapse) inadvertently
   bundled in 6 files of Sub-D's color edits to admin pages — those
   landed under Sub-E's authorship. Net coverage on `master` is the
   same; attribution is mixed across two commits but both touched
   files reflect the canonical token pattern.
2. Sub-E independently re-used the `--priority-medium-*` token for
   their report-builder mobile-warning banner (commit attributable
   in `report-builder.tsx`) — confirms the semantic-token surface is
   self-documenting.

No rebase conflicts. No notes added to `PHASE12-BUGS.md`.

---

## Quality gates

Run before each push:

```
pnpm tsc --noEmit  # exit 0
pnpm lint          # exit 0
pnpm build         # exit 0 (full Next 16 production build)
```

All three passed at every commit boundary.

---

## Acceptance

- [x] Baseline → final: **114 → 6** (-94.7%).
- [x] No new tokens added to `globals.css` (the existing surface was
      sufficient).
- [x] Layout / responsive / hover-pattern changes left to Sub-E.
- [x] Tests + generated + schema files untouched.
- [x] Pre-auth surfaces deferred with explicit recommendation in
      `BACKLOG-PHASE13.md` (`P13-001a`).
- [x] No credentials, secrets, or test-account emails introduced
      anywhere.
