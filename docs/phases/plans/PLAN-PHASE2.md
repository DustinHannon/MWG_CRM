# PLAN — MWG CRM Phase 2

> Working plan. Each section maps to a phase in the brief. Each line in §3
> tracks a discrete commit / push to `master`. Verify Vercel deploy is green
> after each push before continuing.

## 0. Discovery

- shadcn/ui is **not** installed. Project uses native HTML elements with
  custom Tailwind v4 (`@theme` block, brand tokens). The "white background
  invisible text" bug is the native `<select>` `<option>` elements rendering
  in browser default colors against the dark theme.
- Tailwind v4 is on, dark-only design, glass aesthetic.
- Auth helpers exist (`requireSession`, `requireAdmin`, `requirePermission`,
  `getPermissions`). Need `requireLeadAccess`, `requireSelfOrAdmin`.
- No `vercel.json`. `next.config.ts` is empty (no headers config).
- Phase 2F new features (column chooser, view selector, combobox, charts)
  benefit hugely from shadcn primitives — install during Phase 2A.

## 1. Phase 2A — Bug fixes

### 2A.1 — Dropdown rendering (~1 push)
- Install shadcn/ui (CLI init + components: `button`, `select`,
  `dropdown-menu`, `popover`, `command`, `dialog`, `label`, `input`,
  `checkbox`, `switch`, `badge`, `table`, `sonner`, `tooltip`, `chart`,
  `radio-group`).
- Rewrite `src/app/globals.css` with brief §1.1 recipe:
  - `:root` raw shadcn semantic tokens
  - `.dark` raw shadcn semantic tokens
  - `@theme inline` mapping (replaces existing `@theme` brand-only block)
  - keep brand tokens, glass surfaces
  - tune values toward MWG navy palette
- Force dark mode for now: `<html className="dark">` in
  `src/app/layout.tsx`.
- Add `[&>option]:bg-slate-800 [&>option]:text-white` to every native
  `<select>` until they're replaced by shadcn `<Select>` (covers immediate
  visible bug while shadcn install lands).
- Replace native selects on `/leads` filter form, lead form, admin user
  permissions panel with shadcn `<Select>`.
- Test in production: open every dropdown.

### 2A.2 — Apply button (~1 push)
- Reproduce in production. Pull Vercel runtime logs filtered by
  `requestId`.
- Most likely root cause: form's `Object.entries(searchParams)` builds
  the export href with `[k, undefined]` cast, but the Apply button is
  itself a `type=submit`. Working hypothesis: `tag` field passed but
  `tag=undefined` URL param — listLeads chokes when parsing. Or: the
  `defaultValue` for sp.tag is missing from the JSX entirely so the form
  submit serialises bad data.
- Add explicit `action="/leads"` and `method="get"` on the filter form.
- Wrap `listLeads` in try/catch + return safe shape.
- Add a sonner toast on the page for client-side errors.

## 2. Phase 2B — Security review (~1 push)

Pre-flight (parallel):
- `pnpm audit --prod` — bump HIGH/CRITICAL.
- Confirm Next.js 16.1.6 covers CVE-2025-66478 / 55183 / 55184. Bump if not.
- Grep for client-side env leaks (`grep "process.env" src/components/`).
- Add `import "server-only"` to `src/db/index.ts`, `src/lib/graph*.ts`,
  `src/lib/breakglass.ts`, `src/lib/entra-provisioning.ts`.

Defense in depth (one pass):
- Add `requireLeadAccess(session, leadId)` and `requireSelfOrAdmin(session, userId)` to `src/lib/auth-helpers.ts`.
- Walk every server action and `route.ts`. Confirm each has session +
  permission check. List in `SECURITY-NOTES.md`.

Cookie + session:
- Set `session.maxAge = 60 * 60 * 24` in `src/auth.ts`.

Headers + config:
- Replace `next.config.ts` with `securityHeaders` block from brief.
- `productionBrowserSourceMaps: false`, `poweredByHeader: false`.

Middleware:
- Audit matcher in `src/proxy.ts`. Verify no public API routes outside
  `/api/auth/*`.

Rate limit (lightweight):
- In-memory limiter on breakglass `authorize()` — 5 attempts per username
  per 15 minutes; return null after that and audit-log.

Write `SECURITY-NOTES.md` with audit checklist + findings.

## 3. Phase 2C — DB integrity (~1 push)

Single Drizzle SQL migration `0001_phase2_integrity.sql`:
- Drop existing FKs on `leads.owner_id`, `leads.created_by_id`,
  `leads.updated_by_id`, `activities.user_id`, `audit_log.actor_id`,
  `import_jobs.user_id`, `attachments.activity_id`.
- Re-create with rules from brief §3.1.
- Update Drizzle schema files to match (`onDelete: "restrict"` for
  `leads.owner_id`).
- Write `scripts/test-integrity.ts` (NOT shipped — `.vercelignore`).
- Add `.vercelignore`.
- Add `cleanupBlobsForLead(leadId)` and `cleanupBlobsForUser(userId)` to
  `src/lib/blob-cleanup.ts`.

## 4. Phase 2D — Schema additions (~1 push)

Drizzle SQL migration `0002_phase2_features.sql`:
- `lead_creation_method` enum (`manual`, `imported`, `api`).
- `leads.created_via`, `leads.import_job_id` columns.
- `saved_views` table.
- `user_preferences` table.
- Backfill `user_preferences` for existing users.

Update Drizzle schema files. Regenerate types.

## 5. Phase 2E — DNC UX + admin SQL (~1 push)

- Refactor `lead-form.tsx` to make `doNotContact` checkbox auto-toggle
  `doNotEmail` and `doNotCall`.
- Add zod refinement on lead-write schema.
- Promote `dustin.hannon` to admin via Supabase MCP `execute_sql`.

## 6. Phase 2F — New features

### 2F.1 — Views system (~2-3 pushes)
- `src/lib/views.ts` — built-in view definitions + saved view CRUD.
- `src/lib/leads.ts` — extend `listLeads` to accept full FilterDef +
  ColumnDef + SortDef.
- `/leads/page.tsx` — replace static page with view-driven version using
  shadcn `<Select>` for view picker, `<DropdownMenu>` for column chooser,
  `<Dialog>` for "Save as new view" modal.
- Persist `last_used_view_id` on view selection.

### 2F.2 — Dashboard charts (~1 push)
- KPI strip + 4 charts using shadcn `<Chart>`.
- Empty-state CTA card.
- `revalidate = 60`.

### 2F.3 — Lead detail provenance (~1 push)
- Surface "Created by [name] on [date]" line.
- "Imported" badge with hover tooltip showing job filename.

### 2F.4 — Admin user delete (~1 push)
- Lead count column on `/admin/users`.
- Delete user flow with reassign vs cascade-delete radio.
- Block self / breakglass / last-admin.
- Single transaction with Blob cleanup.

## 7. Final report

After all phases, post acceptance summary covering every checklist item.
