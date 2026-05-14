# MWG CRM — Engineering Standards

> Single source of truth for naming, structure, error handling, theming, and review conventions.
> `CLAUDE.md` (root) is the short index of non-negotiables; this is the deep reference.
> Verified against the codebase at `dde393c` (2026-05-09, Phase 16).

## 1. Project layout (actual, as of Phase 15)

```
src/
├── app/
│   ├── (app)/                    # authenticated routes (sidebar-shell layout)
│   │   ├── accounts/
│   │   ├── contacts/
│   │   ├── dashboard/
│   │   ├── leads/
│   │   ├── notifications/
│   │   ├── opportunities/
│   │   ├── reports/
│   │   ├── settings/
│   │   ├── tasks/
│   │   ├── users/
│   │   ├── welcome/
│   │   └── layout.tsx
│   ├── admin/                    # admin-only routes (top-level, gated by requireAdmin)
│   ├── auth/                     # signin / disabled (deliberate dark aesthetic)
│   ├── api/                      # REST API + cron + admin endpoints
│   │   ├── v1/                   # public REST surface
│   │   └── cron/                 # scheduled jobs
│   ├── apihelp/                  # public Scalar reference (no auth)
│   ├── leads/                    # legacy unauthenticated route stub (kept for SEO/inbound)
│   ├── reports-print/            # print-only report renderer
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── admin/                    # admin-specific shared
│   ├── app-shell/                # sidebar, topbar, brand, breadcrumbs, search
│   ├── breadcrumbs/
│   ├── command-palette/
│   ├── delete/                   # ConfirmDeleteDialog, DeleteIconButton, undo toast
│   ├── leads/                    # lead-specific (score-badge, duplicate-warning, etc.)
│   ├── notifications/
│   ├── realtime/                 # RealtimeProvider, PageRealtime, RowRealtime, PagePoll
│   ├── reports/
│   ├── tags/
│   ├── theme/
│   ├── ui/                       # primitive wrappers (avatar, glass-card, popover, status-pill, priority-pill, tooltip, user-time)
│   ├── user-display/
│   └── user-panel/
├── db/
│   ├── index.ts                  # postgres-js client + drizzle factory
│   └── schema/                   # one file per topic; current set (refreshed 2026-05-10 / Phase 25 §7.7):
│       ├── activities.ts                  # activities, attachments
│       ├── api-keys.ts                    # api_keys + api_usage_log
│       ├── audit.ts                       # audit_log (append-only; request_id column)
│       ├── crm-records.ts                 # crm_accounts, contacts, opportunities
│       ├── d365-imports.ts                # d365 import runs / batches / records (Phase 23)
│       ├── email-send-log.ts              # email_send_log (transactional + marketing sends, Phase 15+21)
│       ├── enums.ts                       # shared pg enums
│       ├── imports.ts                     # XLSX import_jobs
│       ├── index.ts                       # barrel re-export
│       ├── lead-scoring.ts                # scoring_rules, scoring_thresholds
│       ├── leads.ts                       # leads
│       ├── marketing-campaigns.ts         # marketing_campaigns + marketing_campaign_recipients (snapshot_merge_data jsonb, Phase 24 §6.5.1)
│       ├── marketing-events.ts            # marketing_email_events (SendGrid webhook ingestion)
│       ├── marketing-lists.ts             # marketing_lists + marketing_list_members
│       ├── marketing-templates.ts         # marketing_templates (Unlayer designs + SendGrid Dynamic Template ids)
│       ├── recent-views.ts                # Cmd+K MRU
│       ├── saved-reports.ts               # saved_reports + saved_report_runs
│       ├── saved-search-subscriptions.ts  # saved_search_subscriptions (digest)
│       ├── security.ts                    # rate_limit_buckets + webhook_event_dedupe (Phase 20 primitives)
│       ├── tags.ts                        # tags + per-entity link tables
│       ├── tasks.ts                       # tasks
│       ├── users.ts                       # users + auth.js accounts + sessions + permissions + user_preferences
│       └── views.ts                       # saved_views
├── hooks/
│   └── realtime/                 # use-table-subscription, use-realtime-poll
├── lib/
│   ├── access/
│   │   └── can-delete.ts
│   ├── actions/
│   │   └── soft-delete.ts        # undo-token signing helpers
│   ├── api/                      # public REST scaffolding
│   │   ├── handler.ts            # withApiHandler
│   │   ├── auth.ts, errors.ts, token.ts, session.ts
│   │   └── v1/                   # zod schemas + serializers
│   ├── email/                    # generic Microsoft Graph sender (Phase 15)
│   │   ├── send.ts, preflight.ts, graph-app-token.ts, types.ts, index.ts
│   ├── import/                   # XLSX import pipeline
│   ├── openapi/                  # zod-to-openapi assembly
│   ├── realtime/                 # JWT mint, client factory
│   ├── reports/                  # access, repository, request-schemas, schemas
│   ├── scoring/                  # lead score engine
│   ├── validation/               # primitives, file-upload
│   ├── leads.ts, accounts.ts, contacts.ts, opportunities.ts, tasks.ts, activities.ts, tags.ts, views.ts, notifications.ts, recent-views.ts, mention-parser.ts, …
│   ├── auth.ts, auth-helpers.ts, auth-redirect.ts, breakglass.ts
│   ├── audit.ts, errors.ts, server-action.ts, logger.ts
│   ├── env.ts, format.ts, format-time.ts, password.ts, utils.ts
│   ├── graph.ts, graph-token.ts, graph-email.ts, graph-meeting.ts, graph-photo.ts
│   ├── digest-email.ts, blob-cleanup.ts, conversion.ts, saved-search-runner.ts
│   └── xlsx-import.ts, xlsx-template.ts
├── auth.ts                       # Auth.js v5 entry
├── auth-handlers.ts
├── proxy.ts                      # routing-middleware (Next.js middleware)
└── types/
```

Notes:
- Top-level `src/lib/<entity>.ts` (e.g. `leads.ts`, `accounts.ts`) holds CRUD + helpers for that entity. **There is no separate `src/lib/db/queries/` directory.**
- `src/lib/actions/` holds shared action utilities (currently just `soft-delete.ts` for undo tokens). Per-route server actions live next to their route as `src/app/<segment>/actions.ts`.

## 2. Naming conventions

### 2.1 Files
- **kebab-case** for all `.ts` and `.tsx` files: `status-pill.tsx`, `use-table-subscription.ts`, `lead-constants.ts`, `confirm-delete-dialog.tsx`.
- One file per route segment for server actions: `actions.ts` (or descriptive: `view-actions.ts`, `delete-user-actions.ts`).
- Schema files: `<topic>.ts` matching the entity (e.g. `src/db/schema/leads.ts`).

### 2.2 Functions in `src/lib/<entity>.ts`
- Read one: `getXById(id)` — direct PK fetch.
- Read one for API: `getXForApi(id, args)` — includes API-shape hydration.
- Read many: `listX(...)` (UI), `listXForApi(...)` (API), `listXForY(...)` (scoped variants like `listTasksForUser`, `listTasksForLead`, `listTasksDueTodayForCron`).
- Create: `createX(input)`. API variant: `createXForApi(input)`.
- Update: `updateX(id, input)` (or `updateX(actor, record, version, input)` when OCC-aware). API variant: `updateXForApi`.
- Soft-delete batch: `archiveXsById(ids, actor)`.
- Hard-delete batch: `deleteXsById(ids)`.
- Restore batch: `restoreXsById(ids, actor)`.
- Activities are an exception (single-record helpers): `softDeleteActivity(id, actor)`, `deleteActivity(id)`.

### 2.3 Server actions
- One file per route segment: `src/app/(app)/<entity>/actions.ts`, `src/app/(app)/<entity>/new/actions.ts` (creates), `src/app/(app)/<entity>/[id]/<sub>/actions.ts`, etc.
- All exported functions named `verbEntityAction` — `createLeadAction`, `updateLeadAction`, `softDeleteLeadAction`, `restoreLeadAction`, `hardDeleteLeadAction`, `undoArchiveLeadAction`, `convertLeadAction`, `addNoteAction`, `markReadAction`, `subscribeToViewAction`, etc.
- Soft-delete actions are `softDeleteXAction` (not `archiveXAction`); they delegate to `archiveXsById` in lib.
- All return `Promise<ActionResult<T>>` from `@/lib/server-action`.

### 2.4 Types and schemas
- Entity type: `Lead`, `Account`, `Contact`, `Opportunity`, `Task`, `Activity`. Not `LeadRecord`/`LeadModel`/`LeadEntity`.
- DB row types: usually inferred (`type Lead = typeof leads.$inferSelect`).
- Zod schemas: `leadCreateSchema`, `leadPartialSchema`, `leadUpdateSchema`. The corresponding TS type is named (`LeadCreateInput`, `LeadUpdateInput`).
- Zod schemas may be exported alongside types from the same lib file or under `src/lib/api/v1/<entity>-schemas.ts` for the public API surface.

### 2.5 Variables
- camelCase in TypeScript: `leadId`, `ownerId`, `pageSize`, `cursorAfter`.
- snake_case only inside raw SQL strings (e.g. `sql\`select count(*) from public.leads where deleted_at is null\``).
- Booleans prefixed `is*`, `has*`, `should*`, `can*`: `isAdmin`, `hasMailbox`, `shouldSkipSelf`, `canDeleteLead`.
- React identifiers PascalCase: `StatusPill`, `RealtimeProvider`. Hook identifiers `useX`: `useTableSubscription`, `useRowSubscription`, `useRealtimePoll`.

## 3. Server actions — canonical shape

Reference: `src/app/(app)/leads/actions.ts` (`createLeadAction`, `updateLeadAction`, `softDeleteLeadAction`, `hardDeleteLeadAction`, `restoreLeadAction`).

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  requireSession,
  requireLeadEditAccess,
  getPermissions,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { updateLead, leadPartialSchema } from "@/lib/leads";

export async function updateLeadAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary({ action: "lead.update" }, async () => {
    const user = await requireSession();
    const id = z.string().uuid().parse(formData.get("id"));
    const version = z.coerce.number().int().positive().parse(formData.get("version"));

    // 1. Permission gate + load — never trust the id implicitly.
    const lead = await requireLeadEditAccess(id, user.id);

    // 2. Validate.
    const parsed = leadPartialSchema.safeParse(formToObject(formData));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first ? `${first.path.join(".") || "input"}: ${first.message}` : "Validation failed.",
      );
    }

    // 3. Mutate (lib enforces OCC via the version arg; throws ConflictError on stale).
    const updated = await updateLead(user, lead, version, parsed.data);

    // 4. Audit.
    await writeAudit({
      actorId: user.id,
      action: "lead.update",
      targetType: "lead",
      targetId: lead.id,
      after: parsed.data,
    });

    // 5. Revalidate / redirect.
    revalidatePath(`/leads/${lead.id}`);
    return updated;
  });
}
```

Conventions:
- Action verb names match user intent (`softDeleteLeadAction`, `convertLeadAction`).
- Lib helper names match the SQL operation (`archiveLeadsById`, `deleteLeadsById`).
- The two-layer naming is deliberate; do not collapse it.
- Restore comes in two flavors: `undoArchiveXAction` (single id, fired by undo toast, cheap path) and `restoreXAction` (from archived view, full-fat path).

## 4. Errors

Hierarchy in `src/lib/errors.ts`:

```
KnownError(code, publicMessage, internalMessage?, meta?)
├── ValidationError       code: VALIDATION
├── NotFoundError         code: NOT_FOUND
├── ForbiddenError        code: FORBIDDEN
├── ConflictError         code: CONFLICT       (OCC version mismatch, unique conflicts)
├── RateLimitError        code: RATE_LIMIT
└── ReauthRequiredError   code: REAUTH_REQUIRED
```

- Server actions and API handlers throw `KnownError` subclasses for expected failures. The boundary (`withErrorBoundary` for actions, `withApiHandler` for API) converts to a stable `{ ok: false, code, error, requestId }` envelope.
- `throw new Error(...)` is reserved for invariant violations / true bugs and should be paired with a comment explaining the invariant.
- Auth.js / Next.js control-flow throws (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`) are detected and re-thrown by `withErrorBoundary` — don't manually catch them.

## 5. Logging

- Server: `logger` from `@/lib/logger` — structured one-line JSON. Levels: INFO, WARN, ERROR.
- Server actions and API handlers should log at the boundary (`withErrorBoundary` / `withApiHandler` already do this). Add a manual log only when the boundary won't capture what you need.
- Client: `console.warn` / `console.error` for diagnostic fallbacks (e.g. unknown enum render in `status-pill`, polling-tick failure in `useRealtimePoll`). Comment the rationale.
- `console.log` is forbidden in production code.

## 6. Theming

### 6.1 Colors
- Use semantic Tailwind tokens: `bg-background`, `bg-muted`, `bg-input`, `bg-popover`, `bg-destructive`, `bg-glass-3`; `text-foreground`, `text-muted-foreground`, `text-destructive`, `text-popover-foreground`, `text-destructive-foreground`; `border-border`, `border-glass-border`, `border-input`.
- Status pills use the `--status-*` and `--priority-*` CSS variables. Reference: `src/components/ui/status-pill.tsx`, `src/components/ui/priority-pill.tsx`. The variables are defined in `src/app/globals.css`.

### 6.2 Spacing
- Tailwind default scale.
- Arbitrary spacing values like `p-[13px]`, `gap-[7px]` are not allowed when the default scale fits. Round to the nearest scale step.
- Component-fixed pixel values (`w-[280px]`, `h-[260px]`, `max-w-[85vw]`) are allowed where they reflect a designed dimension (popover widths, chart heights).

### 6.3 Typography
- Body: `text-sm`.
- Headings: `text-2xl font-semibold` (H1), `text-xl font-semibold` (H2), `text-lg font-medium` (H3).
- Captions / over-lines: `text-xs text-muted-foreground` or `text-[10px] uppercase tracking-wide text-muted-foreground` (Phase 11 idiom).
- Allowed weights: `font-normal`, `font-medium`, `font-semibold`.
- Forbidden weights: `font-bold`, `font-light`, `font-black`, `font-thin`, `font-extralight`, `font-extrabold` — anywhere.
- Arbitrary `text-[10px]` / `text-[11px]` / `text-[0.85em]` and `tracking-[0.2em]` / `tracking-[0.3em]` are allowed; they're the canonical micro-typography.

### 6.4 Icons
- lucide-react is the only icon library.
- Sizes: `h-4 w-4` (16px), `h-[18px] w-[18px]` (18px), `h-5 w-5` (20px), `h-6 w-6` (24px). Pick the size matching the surrounding text.
- Stroke width is the lucide default; specify `strokeWidth={1.5}` only if the design calls for a lighter weight.

## 7. Components

What exists and is canonical:
- `src/components/ui/avatar.tsx` — user avatars.
- `src/components/ui/glass-card.tsx` — glassmorphism card primitive used across dashboards and detail headers.
- `src/components/ui/popover.tsx`, `tooltip.tsx` — Radix wrappers.
- `src/components/ui/status-pill.tsx`, `priority-pill.tsx` — status + priority badges.
- `src/components/ui/user-time.tsx`, `user-time-client.tsx` — date / relative-time renderers (server + client variants).
- `src/components/delete/confirm-delete-dialog.tsx` — the delete confirmation dialog. Reuse for any destructive action.
- `src/components/delete/delete-icon-button.tsx` — the in-row delete trigger.
- `src/components/realtime/realtime-provider.tsx` — JWT bridge; mounted at `src/app/(app)/layout.tsx`.
- `src/components/realtime/page-realtime.tsx`, `page-poll.tsx`, `row-realtime.tsx` — page-level realtime mounting helpers used by list pages.
- The CSS rule for `[data-row-flash="new"]` lives in `src/app/globals.css` and fires the row-flash transition for any element that sets that data attribute. The helper component that previously set the attribute was removed in Phase 16 because it was never wired up; the CSS rule is retained as a future hook.

What is **not** abstracted (and is not allowed to be in this phase):
- `<EmptyState>`, `<Skeleton>`, `<DataTable>`, `<FilterBar>`, `<PageHeader>`. The inline patterns these would replace are intentionally inline. Future phases may extract.

## 8. State management

- Server state: server components + server actions (RSC pattern).
- Realtime state: `useTableSubscription` (lists) / `useRowSubscription` (detail) / `useRealtimePoll` (poll fallback). Most pages use the wrapper components `<PageRealtime>`, `<RowRealtime>`, `<PagePoll>`.
- Forms: `react-hook-form` + Zod + `@hookform/resolvers/zod`. Reference: `src/components/leads/lead-form.tsx` (or any `<entity>-form.tsx`).
- Local UI state: `useState` / `useReducer`. No global state library; the realtime context (`@/components/realtime/realtime-provider`) is the only React context.

## 9. Database

- Drizzle ORM over postgres-js.
- Pooler: Supabase Supavisor in transaction mode. The postgres-js client must use `max: 1` (Drizzle 0.45 + pooler requirement; see `src/db/index.ts`).
- Migrations: drafted with `pnpm db:generate`, validated with `pnpm db:check`, **applied via Supabase MCP `apply_migration`** against the production project. The live schema is the source of truth.
- After any migration: `get_advisors` for `security` AND `performance` via Supabase MCP. Resolve any HIGH advisors before proceeding.
- RLS: every table has RLS enabled. New tables must include explicit policies (see Phase 15's `email_send_log` migration for the pattern).
- Optimistic concurrency: every entity has a `version` integer column. Client passes the version through the form; lib helpers assert `version_db === version_client` and bump on success. Mismatch throws `ConflictError`.

## 10. Realtime

- Supabase Realtime via the postgres-changes channel on `public.<table>`.
- Hooks: `useTableSubscription` (list, returns nothing — calls `onChange`), `useRowSubscription` (detail-page row), `useRealtimePoll` (polling fallback).
- Drop-in components: `<PageRealtime entities={[…]} />` (refreshes the page on change), `<RowRealtime entity={…} id={…} />`, `<PagePoll entities={[…]} />` (Phase 11 polling fallback).
- JWT bridge mints a Supabase-compatible JWT from the Auth.js session (see `src/lib/realtime/`); `<RealtimeProvider>` refreshes it before expiry.
- RLS helpers in the public schema enforce per-row access (Phase 12 — referenced from project memory `phase12_realtime_architecture`).
- Skip-self uses the `created_by_id` / `updated_by_id` stamping columns. The `withActor(userId, fn)` pattern (where present) ensures the SET LOCAL stamping inside the transaction so realtime sees the actor.
- Flash UX: set `data-row-flash="new"` on the row's outermost element; CSS handles the visual transition. No animation library is installed.

## 11. Testing

- Playwright suite is **local-only** (gitignored). Runs from a developer's machine with `PLAYWRIGHT_LOGIN_*` env vars against production.
- Test runs are tagged with `[E2E-${runId}]` (timestamp/UUID); cleanup respects this marker.
- `pnpm test:e2e:desktop` / `:mobile` / `:tablet` from the repo's `tests/` directory.
- No unit tests in CI; we rely on TypeScript strict + ESLint + the Playwright suite + manual smoke after deploy.

## 12. Deviations from STANDARDS

Documented exceptions — these are the only places the rules above are intentionally bent.

1. **ExcelJS Buffer typing** — `@ts-expect-error` allowed in `src/lib/import/parse-workbook.ts:33` and `src/lib/xlsx-import.ts:130` until ExcelJS publishes Node 24 compatible types.
2. **Auth-screen aesthetic** — `src/app/auth/signin/page.tsx`, `signin-form.tsx`, `microsoft-button.tsx`, `disabled/page.tsx` use raw `bg-slate-950`, `bg-blue-500/20`, `bg-white/5`, `border-white/10`, `text-slate-900` etc. for a deliberate dark-glassmorphism aesthetic distinct from the in-app theme. Do not migrate.
3. **HTTP-status / severity colors** — `src/app/admin/api-usage/page.tsx` and `src/app/admin/email-failures/email-failures-client.tsx` use raw `bg-red-500/15`, `text-red-400`, `bg-amber-500/15`, `text-amber-400` to render HTTP-status (4xx amber, 5xx red) and severity (failed=red, retry=amber). The colors are semantically tied. Do not migrate.

(Phase 24 — the prior "§12.4 API-keys warning banner" exception was removed when the `bg-amber-500/40` / `bg-amber-500/10` classes in `api-keys-admin-client.tsx` were migrated to semantic `bg-accent/40` / `bg-muted/40 border-border` tokens. The api-keys page is no longer in the documented-exceptions list.)
5. **Activity helpers are single-record** — `softDeleteActivity` / `deleteActivity` instead of `archiveActivitiesById` / `deleteActivitiesById`. Activity ops are inherently per-row.
6. **Two-layer soft-delete naming** — server actions use `softDeleteXAction`; lib helpers use `archiveXsById`. Action verb matches user intent; lib name matches SQL.
7. **Best-effort `writeAudit`** — the audit helper swallows write failures by design. No try/catch around its callers.
8. **Auth helpers re-export `ForbiddenError`** — `src/lib/auth-helpers.ts` re-exports `ForbiddenError` for ergonomics; the canonical class still lives in `src/lib/errors.ts`.

## 13. Forbidden patterns (compiled)

- `console.log` in production code.
- `as any` / `: any` / `<any>` in production TS.
- `@ts-ignore` without comment.
- Raw color tokens outside §12 exceptions.
- `font-bold`, `font-light`, `font-black`, `font-thin`, `font-extralight`, `font-extrabold`.
- Bare `throw new Error(...)` for app-domain errors.
- Mocking the database in tests.
- New utility / component / hook abstractions during cleanup phases.
- New dependencies without explicit phase approval.
- Bypassing canonical paths: `sendEmailAs`, `useTableSubscription`, `writeAudit`, `withErrorBoundary`, `withApiHandler`.
- Editing `tests/` from agent sessions (suite is local-only).
- Hard-deletes from non-admin paths.

## 14. Documentation

Doc tree (post-Phase 16):
- `CLAUDE.md` (root) — agent rules, ≤350 lines. **Gitignored by project policy** (AI MD files do not ship to GitHub). Cross-references this file as the binding source.
- `README.md` (root) — human entry point, ≤150 lines.
- `docs/STANDARDS.md` — this file, length as needed. **Versioned.** The single source of truth for binding engineering rules.
- `docs/code-review-prompt.md` — the CRTSE rubric used by review sub-agents.
- `docs/architecture/ARCHITECTURE.md` — system overview.
- `docs/architecture/SECURITY-NOTES.md` — security posture / retention / RLS / CSP.
- `docs/realtime-architecture.md` — Phase 12 realtime design.
- `docs/known-races.md` — accepted concurrency tradeoffs (KR-XXX entries).
- `docs/archive/` — historical phase artifacts (PLAN-PHASE2..15, PHASE4..15-*).

Live docs are reality-checked against the codebase whenever they change. If a claim doesn't match the code, the doc is wrong, not the code.

**Governance source-of-truth posture (added 2026-05-13):** This file (`docs/STANDARDS.md`) is the only versioned, agent-binding rules document. `CLAUDE.md` at repo root remains a local-only operational handbook for Claude Code that cross-references the sections below. Future agents that join the project read STANDARDS.md first; CLAUDE.md is a thin pointer.

## 15. Full-stack chain integrity

Every change to a structured concept must trace its full chain. Single-layer changes that don't propagate produce drift that surfaces as user-visible bugs later. Six of 22 Phase 32.7 review findings (F-08, F-09, F-11, F-12, F-13, F-14) were chain failures caught accidentally rather than systematically — this rule prevents recurrence.

### 15.1 When this rule applies

The following change types trigger a chain walk:

- **Column or field** added, removed, renamed, retyped, or made required/optional
- **Filter** added, removed, or changed in semantics
- **Enum or status value** added, removed, renamed, or reordered
- **Permission** added, removed, or scope-changed
- **Audit event** added, removed, or payload-changed
- **Bulk action** added, removed, or scope-changed
- **Route** added, removed, moved, or layout-changed

### 15.2 When it doesn't apply

Exempt changes (no chain walk required):

- Cosmetic only: CSS, copy, layout without state semantics
- Test code only: `tests/**`
- Rollback of a recent change (the original change's chain walk applies; the rollback inherits coverage)
- Documentation edits without behavior change

"I'm in a hurry" is not an exemption.

### 15.3 Procedure

Before completing any change that touches a chain-triggering concept:

1. Identify the concept type from the list above.
2. Look up its chain map in §15.5.
3. Walk every layer. For each layer:
   - If action was taken in this PR: note the commit / file.
   - If no action needed: note `N/A: <one-line rationale>`.
4. The PR is incomplete until every layer is verified or explicitly marked N/A.
5. PR description (or commit message body) includes a chain-verification block listing each layer's status.

### 15.4 Hotfix carveout

A production hotfix may ship with partial chain verification if user impact is severe and time-sensitive. A follow-up commit completing the full chain walk must land within 48 hours, referencing the same finding ID (e.g. `F-14 hotfix` and `F-14 chain sweep`). F-14's `6d1521e` + Pass 3 sweep is the model.

### 15.5 Chain maps (binding)

#### 15.5.1 Column or field chain (21 layers)

1. Drizzle schema `src/db/schema/<entity>.ts` — column definition, type, nullability, default
2. SQL migration in `drizzle/NNNN_*.sql` applied via Supabase MCP `apply_migration`
3. Drizzle journal `drizzle/meta/_journal.json` updated
4. TS types derived from schema reflect column
5. Cursor list API route returns field; sort allowlist includes if sortable; filter validation allows if filterable
6. Server action Zod schemas (create/update) accept column
7. List page: column visibility config; column header in `columnHeaderSlot`; cell renderer; filter UI if filterable
8. Detail page: display + edit form
9. Saved view config persists column visibility/filter state for this column
10. URL state: `?cols=` param accepts column slug
11. Excel export streamer includes column
12. PDF export generator includes column
13. CSV export streamer includes column
14. Import wizard CSV mapping UI offers column as mapping target
15. Import template example CSV download includes column header
16. Import Zod validation schema accepts column with correct type
17. `writeAudit` / `writeAuditBatch` captures column changes in before/after diff
18. Audit log UI displays column changes readably
19. Field-level permission gate via `requirePermission` if column is permission-controlled
20. Search query inclusion if column is searchable
21. DeskPro / D365 / SharePoint sync if entity is AI-indexed and column should be exposed to the LLM

#### 15.5.2 Filter chain (6 layers)

1. UI filter pill in list page filter row
2. URL param
3. Cursor API route accepts filter param, validates against allowlist
4. Saved view config persists filter state
5. Permission check on filter
6. Bulk action scope: `scope.filtered` expansion respects filter

#### 15.5.3 Enum or status chain (8 layers)

1. DB enum type OR check constraint with explicit allowlist
2. TypeScript union type matching allowlist
3. Zod schema enum validation matching allowlist
4. UI dropdown options matching allowlist
5. Filter pill options matching allowlist
6. Import validation accepts only allowlist values
7. Export rendering handles all allowlist values + null gracefully
8. Audit display shows human-readable label for each value

#### 15.5.4 Permission chain (5 layers)

1. `requirePermission` call site at server action boundary
2. Audit emission on permission-gated action
3. UI gate (hide button / disable control)
4. URL gate (redirect or 403 if user types the URL)
5. API route guard (defense in depth even if UI hidden)

#### 15.5.5 Audit event chain (5 layers)

1. `writeAudit` or `writeAuditBatch` emission with consistent event name + payload shape
2. Audit retention policy applies (2-year universal per Phase 25)
3. Audit log UI displays event readably
4. Audit export includes event
5. AI/RAG indexing of audit events if applicable

#### 15.5.6 Bulk action chain (7 layers)

1. UI button in bulk action toolbar
2. URL state for selected ids OR scope marker
3. Scope expansion via `iterateBulkScope` / `expand-filtered.ts`
4. Server action with Zod-validated payload
5. Per-record permission check during iteration
6. Aggregated audit emission via `writeAuditBatch`
7. Rate limit via `withInternalListApi` or equivalent

#### 15.5.7 Route chain (7 layers)

1. Page file at `src/app/.../page.tsx`
2. Layout wrapper provides required contexts (`QueryProvider` per F-14)
3. Breadcrumb registry entry at `src/lib/navigation/breadcrumbs.ts`
4. Sidebar / navigation menu entry
5. Permission gate
6. Mobile drawer entry if applicable
7. Sitemap / robots if public-facing

### 15.6 Audit cadence

- Every PR self-audits via the procedure above (this is the steady-state mechanism).
- Per-phase Pass 5-style targeted audits catch any drift the per-PR rule missed.
- If a chain failure surfaces in production, treat as a process bug: track root cause, update the chain map if a new layer was discovered, capture in `.tmp/claude-md-future-additions.md` for the next STANDARDS.md revision.

### 15.7 Enforcement

Currently documentation-level only. Automated semgrep / lint / CI enforcement is Phase 33+ work. The rule has a soft floor until then — agent and human compliance is the load-bearing mechanism.

## 16. List page scroll behavior

List pages use window-scoped scroll for VERTICAL scroll, and a single-axis horizontal-scroll carveout on the table region for HORIZONTAL scroll. The `StandardListPage` core uses `useWindowVirtualizer` from `@tanstack/react-virtual` for vertical virtualization. Pages MUST NOT introduce their own vertical-scroll surfaces (`overflow-y: auto`, fixed-height containers, calc(100vh - X) heights) — that produces nested vertical scroll which is hostile UX.

**Vertical scroll** is window-scoped only. The document body owns vertical scroll.

**Horizontal scroll** is permitted ONLY on the desktop table region, applied by `StandardListPage` core. When the sum of column natural widths exceeds the table region's viewport width, the wrapping `<div className="overflow-x-auto rounded-lg border border-border bg-card">` engages horizontal scroll. The column-header tier AND the row list scroll together because they share the same `overflow-x-auto` parent and both carry matching min-widths. Mobile cards adapt to viewport width and do not need horizontal scroll.

Sticky elements pin to the top of the viewport during scroll:
- App TopBar (z-30) — sticky at viewport top.
- Sticky chrome group (page header + filters + bulk-selection banner) — `top-14`, z-20. One sticky parent, not multiple sibling stickies, to avoid stacking jitter.

NOT sticky (scrolls with data):
- Column-header row (where present) — renders inside the horizontal-scroll wrapper so it stays aligned with rows during horizontal scroll. Cannot ALSO be vertically sticky because `overflow-x: auto` on the wrapper creates a "scrolling-mechanism" context (per CSS spec) that pins sticky descendants relative to the wrapper instead of the viewport. Trade-off accepted: deep-scroll users rely on the sticky chrome group (page header + filters) for context; they can scroll back up to reference columns. If a future phase wires `<table>` native sticky-thead or JS-driven scroll sync, the column header can become sticky again.
- "Showing N of M" caption — non-sticky `<p>` inside `#list-results`, above the row list. Scrolls away with the data so it doesn't visually compete with the row content during scroll. Screen-reader announcements come from the dedicated ARIA live region in the shell, not this visible caption.

Sticky elements pin to the bottom:
- Bulk action toolbar (when selection active) — fixed positioning at `bottom-4`, z-20.

The sidebar uses `position: fixed; left: 0; top: 0; height: 100dvh` on lg+ viewports. The AppShell exposes the sidebar width as a CSS variable `--sidebar-width` (initial value from `user_preferences.sidebar_collapsed`, updated by the client `Sidebar` on toggle); the main column has `lg:ml-[var(--sidebar-width)]` so the window scroll moves only the content. Mobile (<lg) uses the existing drawer pattern; no margin is reserved.

Scroll restoration is window-scoped: `useScrollRestoration()` from `src/hooks/use-scroll-restoration.ts` reads/writes `window.scrollY` keyed by URL. Called once at the StandardListPage level; do NOT call per-container.

If a specific page genuinely needs a different pattern (rare), use the `// consistency-exempt: scroll-behavior: <reason>` marker and document in §12.

## 17. Canonical list page pattern

The Leads page (`/leads`) is the canonical list page. Every list page in the CRM matches the structure described below within entity-specific carveouts; deviations require a `// consistency-exempt: list-page-pattern: <reason>` marker at the top of the page's client file plus an entry in §12.

The pattern is enforced via `StandardListPage` (`src/components/standard/standard-list-page.tsx`). Pages compose four slots:

1. **`header: StandardPageHeaderProps`** — the page title block.
   - `title`: noun phrase, sentence case. "Leads", "Marketing campaigns".
   - `description`: optional — one factual sentence describing the page, OR omit.
   - `actions`: trailing button cluster (Import / Export / "+ Add X" / page-specific CTAs). Power-user actions hidden below md via `hidden md:inline-flex` wrappers.
   - `controls`: optional segmented selector (e.g., Leads' Table↔Pipeline toggle). Rendered to the LEFT of `actions`.
   - No `kicker` on list pages (eyebrow text reserved for detail pages).

2. **`filtersSlot: ReactNode`** — view selector + filter inputs (NOT the column header).
   - Renders the ViewToolbar (view picker dropdown + MODIFIED badge + Save changes + Columns chooser + Subscribe / Delete view) where the page has saved views. ViewToolbar's view selector + MODIFIED badge are visible on every viewport; Save / Columns / Subscribe / Delete are wrapped in `hidden md:inline-flex` for desktop-only visibility.
   - Renders the FilterBar with controlled inputs (desktop: search input + selects + Apply / Clear buttons in a wrap-flex row; mobile: large search input on its own row + chip-row of selects with `mask-image` edge-fade to indicate horizontal scroll).
   - Mobile chip-row chips MUST be at least `h-11` (44px) tall and use `text-sm`. Below that violates touch-target standards.
   - Both views (mobile-immediate apply vs desktop-deferred apply) MUST dispatch `{ type: "clear" }` to BulkSelectionProvider on filter mutation (per F-07 contract).

3. **`columnHeaderSlot: ReactNode | undefined`** (new in Phase 32.7 Phase 4A) — the desktop column-header row. Pages without a tabular layout (mobile-cards-only, dashboards) omit this slot.
   - For Leads/Accounts/Contacts/Opportunities/Tasks: a `<table>` element wrapping `<thead>` with sortable headers. Set `style={{ minWidth: cols * 140 + 40 }}` so the table is at least as wide as the row list's min-width — they share the same horizontal scrollbar.
   - StandardListPage renders this slot as the first child of the row list's horizontal-scroll wrapper. Column header is NOT vertically sticky (see §16); it scrolls horizontally with rows and scrolls vertically away with the data.
   - Pages migrating from Phase 32.7 §1-3 era that embedded column headers inside `filtersSlot` MUST extract them to `columnHeaderSlot` so the horizontal-scroll wrapper covers both header and rows.

4. **`renderRow` + `renderCard`** — desktop row + mobile card.
   - Desktop row: flex layout with `min-w-0 flex-1` per cell PLUS `style={{ flexBasis: "140px" }}` so cells don't squeeze below 140px. The row's outer container has `style={{ minWidth: cols * 140 + 40 }}` matching the column header tier. Trailing actions cell is `w-10 shrink-0`. Use `data-row-flash="new"` for the realtime row-flash transition.
   - Mobile card: full-width card with avatar/icon (left), primary text + secondary text + status badge, chevron arrow (right). Cards are touch-friendly (≥64px tall typically).
   - Mobile rendered inside a `rounded-lg border border-border bg-card md:hidden` wrapper (provided by StandardListPage core).
   - Desktop rendered inside the horizontal-scroll wrapper (provided by StandardListPage core).

5. **`bulkActions: { banner?, toolbar? }`** — bulk-selection affordances.
   - `banner`: rendered inside the sticky chrome group, below filters. Typically `<BulkSelectionBanner />`.
   - `toolbar`: rendered as a viewport-fixed overlay at the bottom of the page. Typically `<BulkActionToolbar>` wrapping page-specific bulk actions.

**Other binding contracts:**

- **Click-outside on popovers** — use `useClickOutside(ref, onClose, active)` from `@/hooks/use-click-outside`. Do NOT use the legacy `<button class="fixed inset-0 z-40 cursor-default">` backdrop pattern — it is bound by the sticky parent's stacking context and fails to dismiss when clicks land on virtualized rows below the popover.
- **Sticky stacking** — TopBar z-30, chrome group z-20, bulk action toolbar (fixed bottom) z-20. The column-header row is NOT vertically sticky (see §16). Page-level popovers / dropdowns use z-50 for the popover content; they do not need a backdrop element (document-level listener handles dismissal).
- **Scroll restoration** — single window-scoped `useScrollRestoration()` call in StandardListPage. Per-page restoration is not needed; the URL plus window.scrollY is the only key.
- **Mobile responsive contract** — at viewports <768px (`md:hidden` / lack of `md:` modifier): hide power-user affordances (Columns chooser, Save-as-new, Subscribe, Delete view); keep view selector + MODIFIED badge visible; convert column-list to card-list; convert filter selects to large chip-row selects (44px+ tall) with edge-fade for overflow indication; show large "+ Add" CTA in page header.
- **Empty state** — `<StandardEmptyState title="..." description="..." />` from `@/components/standard`. Copy: state + next action. "No leads match this view. Clear filters."
- **Loading state** — `<StandardLoadingState variant="table" />` (default for `loadingState` prop).
- **"Showing N of M" placement** — caption above the row list, inside `#list-results`, not sticky.

**Allowed page-specific deviations** (each requires `consistency-exempt: list-page-pattern: <reason>` marker):

- Tasks page: sortable column headers via URL `?sort=` round-trip (other P0 entities have implicit sort via view definition). Tasks also has status / priority / due-date filter pills as a separate row above the standard chip-row.
- Opportunities: numeric range filter pair (`minAmount` / `maxAmount`) inline in the filter row. Header has Table↔Pipeline toggle via `controls` prop.
- Leads: Table↔Pipeline toggle via `controls` prop. AddVisibleToListButton in header `actions` for marketing-list staging.
- Reports: "Mine only" / "Shared only" filter scopes (instead of owner-based ownership filter). Card-grid layout rather than tabular flex rows.
- Marketing audit: page size 100 (default 50) for high-volume admin reading.
- Admin email-failures: page size 100; per-row Retry button + detail dialog.
- Admin imports/remap: post-action `window.location.reload()` instead of TanStack Query invalidation (acceptable until the StandardListPage exposes its queryClient).
- Admin operational tables (users, audit, email-failures, api-keys, api-usage, d365-import, imports/remap): fixed-width row cells rather than 140px flex-basis; no `columnHeaderSlot`. Documented carveout — admin utility tables with non-uniform intrinsic column widths.
- Archived list pages (5 entities, single shared component): per-row Restore + Delete-permanently action pair instead of 3-dot edit menu; bulk-selection omitted; trailing actions cell widened to 220px. Documented in `src/components/archived/archived-list-client.tsx`.

Pages NOT migrated to StandardListPage (intentional — these are not paginated lists): /leads/pipeline, /opportunities/pipeline, /dashboard, /notifications, /reports/[id], /admin/server-logs (dashboard), /admin/migrations/clickdimensions (bounded worklist), /admin/scoring (settings page).

### 17.1 Canonical detail page task affordance

Detail pages with child task collections (leads, accounts, contacts, opportunities, and any other parent entity that surfaces a TASKS section) use a single task-creation pattern per page. The pattern depends on which other affordances the page already exposes.

**Lead detail page (`/leads/[id]`)** — the page's chrome carries a tabbed Activity composer with Note / Log call / Add task tabs. The TASKS section displays the task list **read-only** here; quick-add is suppressed via `EntityTasksSection`'s `showQuickAdd={false}` prop because the tabbed Add task tab is the canonical task affordance. Two task-creation surfaces on one page is the F-86 duplicate the Pass 6 leftover triage closed.

**Account / Contact / Opportunity detail pages** — the page has no tabbed activity composer. The TASKS section's quick-add row remains the canonical task affordance (`EntityTasksSection`'s default `showQuickAdd: true`).

**Binding rules:**

- The `tasks` table CHECK constraint `tasks_at_most_one_parent` is the single-parent guard. Whichever affordance creates the task sets exactly one entity FK matching the page's scope.
- The audit event for task creation from a detail page is `task.created` (single canonical name). No per-page audit forks (`task.created.from_lead_tab` etc.) — the parent FK in `after_json` carries the entity context for post-hoc forensics.
- The Activity composer's Add task tab on the lead detail page creates an `activities` row with kind=`task` (`activity.task_create` audit). This is a timeline event, NOT a row in the `tasks` table; it does not surface in the TASKS list section. Real-task creation linked to a lead from this page is intentionally absent — the user navigates to `/tasks` for cross-entity task creation. This is the Option B trade locked at Phase 32.7 Pass 5 leftover triage (F-86).

**Deviations** require a `// consistency-exempt: detail-page-task-pattern: <reason>` marker at the top of the page file plus an entry in §12.

### 17.2 Date input click-to-open contract

All `<input type="datetime-local">` and `<input type="date">` instances in the app wire an `onClick` handler that calls `inputRef.current.showPicker()`. The entire input bar opens the native picker, not only the trailing calendar icon. Behavior expectation across modern Chrome, Edge, Safari and Firefox; mobile Safari uses its native sheet picker which `showPicker()` triggers correctly.

**Implementation pattern (via the canonical `useShowPicker` hook):**

```tsx
import { useShowPicker } from "@/hooks/use-show-picker";

const openDatePicker = useShowPicker();

<input
  type="datetime-local"
  onClick={openDatePicker}
  value={value}
  onChange={(e) => setValue(e.target.value)}
  {...rest}
/>
```

The hook returns a memoized click handler. The handler reads the input element from `event.currentTarget` so no `ref` is required at the call site. This deliberate "no ref" shape avoids the `react-hooks/refs` lint rule that flags ref-object property access during render.

**Binding rules:**

- The `showPicker()` call inside the hook is wrapped in `try / catch`. The DOM method throws under several user-activation edge cases and the swallow is intentional (the native fallback handles those cases).
- The capability check `"showPicker" in event.currentTarget` inside the hook guards against pre-2022 browser releases. The fallback is the default native click behavior the input already has.
- The handler runs on the input element only — not on a wrapping label or container — so `event.currentTarget` is correctly the `<input>` DOM node.
- For local `Field` / `Input` / `FieldInput` wrappers in a page that dispatch to multiple input `type`s, gate the `onClick` wiring with `const isDateLike = type === "date" || type === "datetime-local";` so non-date inputs don't carry the picker handler: `onClick={isDateLike ? openDatePicker : undefined}`.
- Long-term, migrating to a shadcn date picker for full cross-browser consistency is preferred. This contract bridges the gap until that work is scoped.

**Deviations** require a `// consistency-exempt: date-input-click-to-open: <reason>` marker plus an entry in §12. The only currently-known acceptable deviation is a date input nested inside a Radix Popover or Dialog where `showPicker()` interacts badly with the floating-UI stacking — the marker documents which floating-UI surface is in play.

## 18. Sub-agent dispatch rules (parallel execution governance)

Phases that dispatch parallel sub-agents (Phase 32.7 Phase 4B, Pass 5, Playwright) follow these binding rules. The rules were refined after Phase 4B exposed a commit-attribution race where two sub-agents' diffs landed under each other's commit messages.

### 18.1 Binding rules

1. **No file overlap between parallel sub-agents.** Coordinator partitions the workspace before dispatch; each sub-agent's files are disjoint from peers'.
2. **Per-agent findings files.** Each sub-agent writes to `.tmp/<phase>-<scope>-subagent-<id>.md`. Sub-agent E (the reviewer) merges them at the end.
3. **Sub-agents are conformers, not decision-makers.** Architectural decisions surface to `.tmp/<phase>-scope-questions.md` for explicit user direction; sub-agents do not lock in irreversible choices unilaterally.
4. **Per-page commits within sub-agent scope.** One file or logical-unit per commit when feasible. Multi-page sweeps land as separate commits unless the change is genuinely a single logical unit (e.g., one shared-component change that propagates across N pages).
5. **Commit-message prefix.** Every commit message is prefixed with the sub-agent identifier: `[<phase>-sub-<id>] <conventional-commit-message>`. Example: `[Pass5-sub-α] fix(crm): column chain — Excel export missing companyName field`.
6. **Chain-verification block in commit body.** Commits that touch a chain-triggering concept per §15.1 include a block listing each layer with action taken or `N/A: <rationale>`. Cosmetic / test-only / rollback commits are exempt per §15.2.
7. **Quality gates per sub-agent before push.** `pnpm tsc --noEmit` 0, `pnpm lint` 0, `pnpm build` clean, on the sub-agent's touched files, before pushing.
8. **No concurrent push within the same minute window.** Coordinated push order prevents commit-attribution mixups when multiple sub-agents finish near-simultaneously. Stagger pushes by ≥60 seconds.
9. **Sub-agent E reviews sequentially with push-back authority.** E validates commit prefix + chain-block presence + scope adherence + cross-contamination. E can reject and push-back to the originating sub-agent.

### 18.2 Stash-and-pop staging discipline

To prevent the Phase 4B contamination race (where one sub-agent's `git add .` swept in a peer's WIP), sub-agents working in a shared tree MUST either:

- Use `git commit -- <specific-files>` style (bypasses the staging area entirely), OR
- Stash unrelated WIP with `git stash --include-untracked --keep-index` before staging, then `git stash pop` after the commit.

Coordinators MAY use `git worktree` to isolate sub-agents from each other; this is the structurally safer pattern but requires more setup. Phase 32.7 Phase 4B opted for the shared-tree approach with the staging-discipline rule added as a follow-up.

### 18.3 Findings floor by review scope

Code review sub-agents have a minimum-finding floor calibrated by review scope (mirrors §13 in spirit):

| Review scope | Minimum findings |
|---|---|
| Full Phase 32 §1.5 depth-doctrine review | 30 |
| Targeted multi-file review (one subsystem) | 15 |
| Tight scoped review (one file / one PR) | 5 |

If a review reports fewer findings than its floor, the review was shallow — re-run with stricter adversarial framing. The floor is not a target; padding with low-severity nits is worse than missing the floor honestly. Bare "no findings" is never acceptable below the floor.


## §19 Data integrity contracts

This section codifies the data integrity contracts that emerged from the Phase 32.7 Pass 6 data-integrity audit. Read before any change that touches multi-step DB writes, audit emission, FK cascades, soft-delete consumers, bulk action atomicity, cursor pagination, sync pipelines, or async send queues.

### §19.1 Transactional integrity

**§19.1.1 Multi-step DB writes MUST be in `db.transaction(...)`.** Any operation that performs two or more DB writes whose intermediate state must not be observable externally is a transaction boundary. Examples that require a transaction:

- Soft-delete or restore of an entity that maintains a denormalized snapshot on its parent (e.g., `softDeleteActivity` + recompute parent `last_activity_at` + parent UPDATE — F-55).
- Bulk member-row INSERT/DELETE + `member_count` snapshot recompute + parent UPDATE (e.g., `createStaticListMembers`, `deleteStaticListMembersById`, `bulkAddLeadsToListAction` — F-56).
- D365 commit-batch dedup_merge that reads existing values and writes conditional patches (use `SELECT ... FOR UPDATE` inside the transaction OR SQL-level `COALESCE(col, $newValue)` so user-write races don't slip in — F-72 deferred).

**§19.1.2 Data writes + audit emission MUST live OUTSIDE a transaction.** `writeAudit` and `writeAuditBatch` are best-effort by design (CLAUDE.md "Auditing"). They MUST NOT run inside a `db.transaction(...)` block — an audit emission failure cannot be allowed to roll back the primary data write. Pattern: open transaction → mutate → close transaction → emit audit afterward.

Verified violation-free at Pass 6 sign-off: 7 `db.transaction` sites (`src/lib/breakglass.ts`, `src/lib/conversion.ts`, `src/lib/d365/commit-batch.ts`, `src/lib/d365/pull-batch.ts`, `src/lib/entra-provisioning.ts`, `src/lib/tags.ts`, `src/app/admin/users/[id]/delete-user-actions.ts`) all emit audits after `tx` returns.

**§19.1.3 If audit emission CANNOT be transactional, document the gap.** Currently no such gap exists. If a future write path needs audit-in-tx semantics (e.g., to roll back a write when audit fails), surface for explicit decision — the default is best-effort fire-after.

### §19.2 Foreign key cascade rules

**§19.2.1 Every FK declaration MUST have explicit `.onDelete()` and `.onUpdate()` policy.** Default-implicit is forbidden. Choices:

- `CASCADE` — parent gone → children gone. Use when child rows have no meaning without parent (e.g., `lead_tags.lead_id`, `marketing_list_members.list_id`).
- `RESTRICT` — block parent delete. Use when child rows are evidence the parent existed (e.g., `email_send_log.from_user_id`, `audit_log.actor_id`, `api_keys.created_by_id`).
- `SET NULL` — orphan but track. Use when the child has meaning post-parent-delete but the link is no longer authoritative (rare; document case-by-case).

Verified Pass 6: 111 of 111 FK declarations across `src/db/schema/*.ts` have explicit policies. New schema files MUST maintain this.

**§19.2.2 RESTRICT FKs that block hard-delete on user-facing flows MUST surface a preflight UI warning.** Users editing an admin "delete user" surface should see "cannot delete — created N templates / sent K emails" before the confirm-text screen, not a raw Postgres FK violation. Pre-Phase-32.7 admin user-delete flow violates this (F-59 documented); future admin UX phase fix.

### §19.3 Soft-delete consumers

**§19.3.1 Every read path on a soft-deletable entity MUST filter `is_deleted = false` (or `deleted_at IS NULL`).** Entities currently soft-deletable: leads, accounts, contacts, opportunities, tasks, activities, marketing_lists, marketing_templates, marketing_campaigns, saved_views, saved_reports, lead_scoring_rules.

**§19.3.2 Documented exceptions** (verified by Pass 6 walk):

- `audit_log` retains references to soft-deleted entities by design (forensic).
- Historical reports may opt out of soft-delete filtering via per-report `includeArchived` flag.
- Cron jobs that purge archived rows (e.g., `purge-archived`) SELECT soft-deleted rows explicitly — they ARE the consumer.

All other consumers must filter. Pass 6 closed three known gaps: scoring `evaluateLead` (F-54), `evaluateLead` activity-aggregate, `updateListAction` UPDATE WHERE (F-68).

**§19.3.3 Soft-deleted parents preserve child rows for restore.** When a parent is soft-deleted (UPDATE `is_deleted = true`), child rows referenced by CASCADE FKs are NOT purged. Restore is reversible (flip `is_deleted = false`). This contract relies on §19.3.1 — child consumers must filter the parent.

### §19.4 Hard-delete blob cleanup

**§19.4.1 Vercel Blob objects MUST be pre-gathered BEFORE the parent DB delete cascades.** The blob-attachment join chain is `attachments → activities → entity`. CASCADE clears the join before any post-delete cleanup query can find the paths. Pattern:

```typescript
// 1. Gather BEFORE delete.
const blobPathnames = await gatherBlobsForLeads(ids);

// 2. Delete (CASCADE clears attachments).
await db.delete(leads).where(inArray(leads.id, ids));

// 3. Pass pre-gathered paths to blob deleter.
if (blobPathnames.length > 0) {
  await deleteBlobsByPathnames(blobPathnames);
}
```

**Anti-pattern**: calling a `cleanupBlobsForX(ids)` helper after delete that re-runs the join query. The join returns empty (CASCADE cleared it), `del()` is a no-op, blobs leak forever. Pre-Phase-32.7 lead hard-delete + user-delete flows shipped this anti-pattern across 3 call sites (F-83, closed in `63e4b63`).

**§19.4.2 Account / contact / opportunity / task hard-delete paths currently leak blob attachments.** Activities can attach to leads, accounts, contacts, opportunities. Only the lead hard-delete path is wired to gather + delete blobs. F-58 scope-questioned for next phase; recommended abstraction `gatherBlobsForActivityParent(kind, ids)` + `deleteBlobsForActivityParent(kind, ids)` satisfies Rule of 3.

### §19.5 Optimistic concurrency control (OCC)

**§19.5.1 Mutable entities edited by multiple users MUST use `version`-column OCC on the primary UPDATE path.** Pattern:

```typescript
const result = await db
  .update(entity)
  .set({ ...patch, version: sql`${entity.version} + 1` })
  .where(and(eq(entity.id, id), eq(entity.version, expectedVersion)))
  .returning({ id: entity.id });

expectAffected(result.length, 1, "Entity was modified by another user");
```

Entities currently OCC-enforced: leads, accounts, contacts, opportunities, tasks, saved_views, marketing_lists, marketing_campaigns, saved_reports, lead_scoring_rules, api_keys (version on metadata only — revoke uses §19.5.2).

**§19.5.2 Status-transition mutations MUST use atomic conditional UPDATE.** When the operation is "transition row from state A to state B", the UPDATE WHERE clause MUST encode the expected `from` state:

```typescript
const result = await db
  .update(entity)
  .set({ status: "B", ...patch })
  .where(and(eq(entity.id, id), inArray(entity.status, ["A"])))
  .returning({ id: entity.id });

if (result.length === 0) {
  throw new ConflictError("Entity no longer in expected state for this transition");
}
```

This pattern closes TOCTOU windows where two clients race between SELECT and UPDATE. Pass 6 closed: api_key revoke (F-61), campaign cancel (F-64), campaign delete (F-65), bulkCompleteTasks (F-71). Marketing template archive (F-67), list delete (F-69), template update OCC (F-66) currently use lock-based OR snapshot-based contracts; future marketing-concurrency phase migrates them to §19.5.2.

**§19.5.3 Last-write-wins entities MUST document the contract.** Some entities intentionally use last-write-wins semantics (`lead_scoring_settings` single-row admin tuning page, F-63). Document via comment at the UPDATE site explaining why OCC is not appropriate.

### §19.6 Bulk action concurrency contract

**§19.6.1 `bulk-actions/expand-filtered.ts` snapshot semantics:**

- Records added to the filter set AFTER expansion: NOT included (intentional — the snapshot is fixed at walk time).
- Records removed from the filter set AFTER expansion: STILL included based on snapshot (intentional).
- Records modified DURING walk (sort-key bumped): may be skipped if the cursor predicate eats the new value (cursor stability is best-effort eventual consistency, NOT snapshot consistency).
- Records hard-deleted mid-iteration: per-record action errors logged + skipped; no transaction abort.

Pass 6 documented this contract inline as a 28-line block comment at the top of `src/lib/bulk-actions/expand-filtered.ts` (F-70, `da58061`).

**§19.6.2 `BULK_SCOPE_EXPANSION_CAP = 5000` is the canonical cap.** All bulk-action paths flowing through `expand-filtered.ts` honor this cap. Library-layer caps (e.g., `bulkTagEntities`) MUST match — Pass 6 fixed `bulkTagEntities` 1000-cap to 5000 (F-76, `678e4e3`). Future bulk-action additions MUST use this constant.

**§19.6.3 Aggregated audit on bulk paths.** When a bulk operation modifies N rows, audit emission uses `writeAuditBatch({ events: [...] })` — one INSERT per chunk of 500 (§19.8.2). The per-row write+audit serial pattern is wrong; it amplifies tail latency and explodes round-trip count under Supavisor. Pass 5 ε refactored the existing surfaces; Pass 6 Ω extended `purge-archived` (F-80).

**§19.6.4 Bulk operations skip-already-in-target-state.** Bulk operations that flip a state column (e.g., bulkCompleteTasks → `status='completed'`) MUST include `<col> != '<targetState>'` in the UPDATE WHERE. Without it, the bulk overwrites timestamps + bumps versions + emits audit rows for non-transitions (F-71 closed).

### §19.7 Audit emission contract

**§19.7.1 `writeAudit` and `writeAuditBatch` are best-effort.** Both helpers internally try/catch all errors and `logger.error`. Audit failure NEVER blocks the primary mutation. This is the contract; callers MUST NOT wrap them in their own try/catch.

**§19.7.2 `writeAuditBatch` is chunked at 500 rows per INSERT.** Pre-Pass-6 implementation was a single INSERT for all N rows — one bad row poisoned all N (F-78). Now chunked via `AUDIT_BATCH_CHUNK_SIZE = 500` with per-chunk try/catch. Worst-case loss: 500 rows per bad row (down from N).

**§19.7.3 Sentinel-user fallback for null-actor audit.** When real-user resolution fails mid-write (e.g., cron purging an orphan-owner lead, F-79), fall back to `SYSTEM_SENTINEL_USER_ID` from `src/lib/sentinel-user.ts` with a structured WARN log line so admins can correlate forensically. The 2-year retention contract (Phase 25) is universal; "skip the audit because actor is null" is forbidden.

**§19.7.4 Audit emission for high-frequency events.** Per CLAUDE.md "Audit emission for high-frequency events" — bulk events MAY aggregate into per-minute audit rows. Governance events (rename, delete, permission change, schema modification) ALWAYS emit per-event regardless of volume. The split:

- **Per-event**: forensic-reconstruction surfaces. `lead.create`, `tag.renamed`, `tag.deleted`, `user.permission_change`, every CRUD on auditable entities.
- **Aggregated**: workflow surfaces where count + timing matter more than per-event detail. `tag.applied.aggregate` with `{ count, sampleIds, firstAt, lastAt }`.

Apply aggregation AFTER a real noise problem is observed, not preemptively. F-41, F-42 (Pass 5 leftover triage) await this decision per-event-shape.

### §19.8 Sync pipeline idempotency

**§19.8.1 Every cron sync run MUST be idempotent.** Failed runs do NOT skip records on retry — the next run reprocesses. The canonical pattern is atomic state-claim:

```typescript
// Claim only rows in the "needs sync" state — atomic.
const claimed = await db
  .update(syncTable)
  .set({ status: "in_progress", claimed_at: sql`now()` })
  .where(eq(syncTable.status, "pending"))
  .returning({ id: syncTable.id });
```

This is Supavisor-safe (CLAUDE.md "Postgres locking under Supavisor"). Do NOT use `pg_try_advisory_lock` outside an explicit transaction — Supavisor's transaction-pool rotates backends and orphans session-scoped locks.

**§19.8.2 Sync pipelines with batch state MUST handle partial failure.** D365 `pull-batch` + `map-batch` + `commit-batch` use `pg_advisory_xact_lock` (transaction-scoped, Supavisor-safe) + atomic batch claim with `RETURNING`. If `commit-batch` partially fails, the next cron tick re-claims the batch and retries.

**§19.8.3 Concurrent UI+cron refresh races MUST be serialized.** `refreshList` currently has a race window where UI-triggered and cron-triggered refreshes can interleave their SELECT-then-write phases (F-73 deferred). Fix shape: wrap in `db.transaction` with `SELECT ... FOR UPDATE` on the parent `marketing_lists` row at the top. Future marketing-concurrency phase.

### §19.9 Cursor pagination stability

**§19.9.1 Cursors are stable under inserts** — new records appear at end of natural sort, never disrupting the in-flight walk.

**§19.9.2 Sort-key mutations during iteration: may skip OR duplicate.** Acceptable for soft-state queries (list-page infinite scroll). NOT acceptable for hard-state queries (bulk-action expansion). Hard-state callers MUST document their consistency contract; see §19.6.1.

**§19.9.3 Hard-delete during iteration: gap in results, not error.** Consumers handle empty rows / null IDs without aborting the iteration.

### §19.10 Async send queue durability

**§19.10.1 Atomic claim before async dispatch.** Pattern for `marketing-process-scheduled-campaigns` and equivalent cron-driven dispatchers:

```typescript
const claimed = await db
  .update(marketingCampaigns)
  .set({ status: "sending", sendStartedAt: sql`now()` })
  .where(and(eq(marketingCampaigns.status, "scheduled"), /* eligibility */))
  .returning({ id: marketingCampaigns.id });
```

The claim is the dispatch trigger. Race-safe under Supavisor.

**§19.10.2 Pre-batch failure paths MUST flip status to a terminal state.** Pre-Pass-6 `sendCampaign` had a race window where pre-batch failures (`loadCampaignContext`, status assertion, `resolveListRecipients`, `insertRecipientRows`, audit emission) escaped the inner try/catch and left the row stuck in `sending` forever. Pass 6 fix (F-74, `367d4b2`) wraps the pre-batch region in a dedicated try/catch + `markStuckSendingFailed` helper. Future async dispatchers MUST follow this pattern.

**§19.10.3 SendGrid 5xx + transient errors retry via `withRetry`.** 3 attempts, exponential backoff (2s/4s/8s), full jitter, Retry-After header respect (capped 30s), per-attempt structured WARN log. After exhaustion the error propagates and the campaign is marked `failed`. Do NOT add retry on top of `withRetry`; the layered retries amplify and break the budget.

**§19.10.4 Webhook idempotency via dedup-claim.** Inbound SendGrid webhook events claim via `webhook_event_dedupe` table. Duplicate events return 2xx without reprocessing. Dedup INSERT failure falls back to at-least-once delivery (bypass mode, structured log line + flag) — intentional design: "rather double-process than drop." The hourly `marketing-sync-suppressions` cron is the resync safety net.

### §19.11 File / attachment cleanup contract

**§19.11.1 Soft-delete preserves attachments.** Parent soft-delete (`is_deleted = true`) leaves all `attachments` rows + Blob objects intact. Restore is reversible.

**§19.11.2 Hard-delete MUST pre-gather + cleanup blobs.** Per §19.4.1.

**§19.11.3 Fire-and-forget cleanup risk.** `void cleanupBlobs(...).catch(...)` doesn't await; lambda termination can kill the in-flight `del()`. Mitigated by Vercel's 300s `maxDuration` headroom but not durable. Future durability phase moves cleanup to its own cron sweeping pre-gathered orphan paths (F-81 deferred).

### §19.12 Enforcement

- New schema files: per §19.2, every FK MUST have explicit `.onDelete()` / `.onUpdate()`.
- New status-transition mutations: per §19.5.2, MUST use atomic conditional UPDATE.
- New bulk paths: per §19.6, MUST use `BULK_SCOPE_EXPANSION_CAP` + `writeAuditBatch` + skip-in-target-state predicate.
- New async dispatchers: per §19.10, MUST use atomic claim + pre-batch failure flip-to-terminal.
- New cron sync pipelines: per §19.8, MUST be idempotent + Supavisor-safe (no session-scoped locks).

Code review sub-agents reviewing data-integrity-touching changes MUST cite the §19 subsection(s) involved in the chain-verification block (per §15.3).

