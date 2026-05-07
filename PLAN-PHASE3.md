# PLAN — MWG CRM Phase 3

> Source brief: PHASE3_BRIEF.md (the v2 prompt). This plan is the execution map; it commits the build order, file map, schema migrations, and key decisions. **Out of scope** for Phase 3: Outlook add-in, Outlook calendar tracking. Both deferred.

**Goal:** Ship 10 sub-phases of CRM features (3A–3J) plus README/ROADMAP refresh (3K). Glass refinement, user-panel redesign, /settings page with Entra-synced read-only fields, first-class tags, tasks + notifications, Kanban pipeline, duplicate detection, lead conversion + Account/Contact/Opportunity, saved-search digests, Cmd+K, strict CSP.

**Architecture:** Continue Phase 1/2 stack (Next.js 16 App Router, Auth.js v5 JWT sessions, Drizzle + Supabase Postgres via Supavisor pooled, Vercel Blob, Microsoft Graph). Add `@dnd-kit/core` + `@dnd-kit/sortable` for Kanban, `cmdk`/shadcn `Command` for palette. Apply migrations via Supabase MCP `apply_migration`; run `get_advisors` after each. Deploy via direct push to `master`; verify each via Vercel MCP.

**Tech Stack:** Next.js 16.2.5, React 19.2.3, Auth.js 5.0.0-beta.30, Drizzle 0.45, postgres-js (max=1), Tailwind v4, shadcn primitives (existing patterns), `lucide-react`, `react-hook-form` + zod, `next-themes`, `sonner`, `recharts`, `@vercel/blob`, Microsoft Graph v1.0.

---

## Existing schema baseline (from `src/db/schema/`)

| Table | Columns relevant to Phase 3 |
|---|---|
| `users` | id, entra_oid, username, email, first_name, last_name, display_name, photo_blob_url, photo_synced_at, is_breakglass, is_admin, is_active, password_hash, session_version, last_login_at, created_at, updated_at |
| `permissions` | user_id (PK), can_view_all_leads, can_create_leads, can_edit_leads, can_delete_leads, can_import, can_export, can_send_email, can_view_reports |
| `accounts` (Auth.js) | userId, type, provider, providerAccountId, refresh_token, access_token, expires_at, token_type, scope, id_token |
| `leads` | id, owner_id, status, rating, source, …person + company + address + estimated_value/close, **tags text[]**, external_id, converted_at, last_activity_at, created_via, import_job_id, created_by_id, updated_by_id, created_at, updated_at |
| `activities` | id, **lead_id** (NOT NULL today), user_id, kind, direction, subject, body, occurred_at, duration_minutes, outcome, meeting_*, graph_*  |
| `attachments` | id, activity_id, filename, content_type, size_bytes, blob_url, blob_pathname |
| `import_jobs` | id, user_id, filename, totals, errors json, status |
| `audit_log` | id, actor_id, action, target_type, target_id, before_json, after_json, request_id, ip_address |
| `saved_views` | id, user_id, name, is_pinned, scope, filters, columns, sort |
| `user_preferences` | user_id (PK), theme, default_landing_page, last_used_view_id, adhoc_columns |

**Phase 3 will add:** entra-profile fields on `users`, more columns on `user_preferences` (timezone, formats, density, custom_landing_path, notify_*, email_digest_frequency), `tags`, `lead_tags`, `tasks`, `notifications`, `accounts` (CRM, distinct from Auth.js — note name collision), `contacts`, `opportunities`, optional FKs on `activities`+`tasks` to those, `saved_search_subscriptions`, `recent_views`. Plus: rename `permissions.can_view_all_leads` → `can_view_all_records`. Plus: `activities.lead_id` becomes nullable + CHECK constraint for "exactly one parent".

> **Naming collision:** Auth.js's table is `accounts` (lowercased `userId`/`providerAccountId`). Phase 3G adds a CRM-domain `accounts` table. **Resolution:** name the new table **`crm_accounts`** in SQL and Drizzle. Keep nav label "Accounts". Documented here so engineers don't accidentally collide.

---

## Build order (execute in this exact sequence)

1. **3A — Glass refinement** — pure CSS + a primitive component. No schema. Push.
2. **3B — User panel + /settings + Entra extended profile** — first migration in Phase 3, plus the auth provisioning extension. Push.
3. **3C — Tags first-class** — migration #2, UI on lead create/edit/filter, /admin/tags. Push.
4. **3D — Tasks + notifications** — migration #3, /tasks, lead-detail tab, bell, cron. Push.
5. **3E — Pipeline Kanban** — no schema; @dnd-kit and a route. Push.
6. **3F — Duplicate detection** — endpoint + UX wiring; no schema. Push.
7. **3G — Lead conversion + new entities** — migration #4 (largest); 4× list+detail pages; conversion modal; Opportunity Kanban; permission rename. Push.
8. **3H — Saved-search subscriptions + email digests** — migration #5 + cron + Graph email render. Push.
9. **3I — Cmd+K palette** — migration #6 (recent_views) + palette UI. Push.
10. **3J — Strict CSP with nonces** — middleware rewrite. Push last because it's invasive. Push.
11. **3K — README + ROADMAP update.** Push.

After every push: verify Vercel deployment via `list_deployments` + `get_deployment_build_logs`. Fix breaks before continuing.

---

## File map by phase

### Phase 3A — Glass refinement

- **Modify:** `src/app/globals.css` — add `--glass-1/2/3`, `--glass-border`, `--glass-shadow`, `--glass-blur`, `--glass-saturate`, `--bg-gradient` to `:root` and `.dark`. Replace existing `body::before` gradient with `--bg-gradient` field. Keep noise-overlay. Add `.glass-surface{,--2,--3}` rules.
- **Create:** `src/components/ui/glass-card.tsx` — `<GlassCard weight?>`.
- **Modify:** `src/app/(app)/layout.tsx` — sidebar shell + topbar wrap in glass.
- **Modify:** `src/app/(app)/dashboard/page.tsx` — KPI cards and chart cards use `<GlassCard>`.
- **Modify:** `src/app/(app)/leads/[id]/**` — lead detail panels use `<GlassCard>`.
- **Modify:** any modal/popover wrappers that already exist (audit + admin + leads).

QA: walk every page in light + dark mode after wiring. Stay under 8 glass surfaces per viewport.

### Phase 3B — User panel + /settings + Entra extended profile

- **Migration `0XXX_phase3_entra_profile_fields`:** add `users.job_title`, `department`, `office_location`, `business_phones text[] DEFAULT '{}'`, `mobile_phone`, `country`, `manager_entra_oid`, `manager_display_name`, `manager_email`, `entra_synced_at`. Index on `manager_entra_oid` partial.
- **Migration `0XXX_phase3_user_prefs_extension`:** add `user_preferences.timezone`, `date_format`, `time_format`, `table_density`, `default_leads_view_id` (FK saved_views), `custom_landing_path`, `notify_tasks_due`, `notify_tasks_assigned`, `notify_mentions`, `notify_saved_search`, `email_digest_frequency`.
- **Modify:** `src/db/schema/users.ts` — add columns in Drizzle.
- **Modify:** `src/db/schema/views.ts` — extend `userPreferences` with new columns.
- **Modify:** `src/lib/entra-provisioning.ts` — extend Graph fetch (`$select` adds jobTitle, department, officeLocation, businessPhones, mobilePhone, country) + `/me/manager` call. Persist to users on every sign-in. Set `entra_synced_at = now()`.
- **Modify:** `src/lib/graph.ts` — add `GraphMeProfileExtended` type and `/me/manager` types.
- **Create:** `src/components/user-panel/user-panel.tsx` — clickable card.
- **Create:** `src/components/user-panel/user-panel-menu.tsx` — popover with Settings + Sign out.
- **Create:** `src/components/ui/avatar.tsx` — avatar w/ photo+initials fallback (deterministic color hash).
- **Create:** `src/components/ui/popover.tsx` — shadcn Popover (if not yet present).
- **Modify:** `src/app/(app)/layout.tsx` — replace bottom-left static block with `<UserPanel>`.
- **Create:** `src/app/(app)/settings/page.tsx` + sub components (Profile/Preferences/Notifications/M365/Account/DangerZone).
- **Create:** `src/app/(app)/settings/_components/*.tsx`.
- **Create:** `src/app/(app)/settings/actions.ts` — server actions for editable preferences (auto-save).
- **Create:** `src/app/(app)/settings/sign-out-everywhere/route.ts` (or server action) — bumps `session_version`.
- **Create:** `src/app/api/auth/disconnect-graph/route.ts` — clears tokens.
- **Modify:** `src/lib/views.ts` (or a new module) — single source of formatting (date/time/timezone) using `date-fns-tz` against user prefs.

### Phase 3C — Tags first-class

- **Migration `0XXX_phase3_tags`:** create `tags`, `lead_tags`. Backfill from `leads.tags` text[] (DO block iterating distinct unnest values).
- **Create:** `src/db/schema/tags.ts` + register in `src/db/schema/index.ts`.
- **Create:** `src/lib/tags.ts` — `listTags()`, `addTagToLead()`, `removeTagFromLead()`, `createTag()`, `updateTag()`, `deleteTag()`, etc. Server actions + audit.
- **Create:** `src/components/tags/tag-input.tsx` — combobox+multiselect with create-on-the-fly.
- **Create:** `src/components/tags/tag-chip.tsx`.
- **Create:** `src/app/admin/tags/page.tsx` — admin list + edit color/name + delete.
- **Modify:** `src/app/(app)/leads/new/page.tsx` and `[id]/edit/page.tsx` — replace tags text[] field with `<TagInput>`.
- **Modify:** `src/lib/views.ts` filter schema — tags filter is now array of tag IDs.
- **Modify:** `src/app/(app)/leads/page.tsx` filter UI — multiselect of existing tags.
- **Color tokens:** add `--tag-<name>` and `--tag-<name>-foreground` for slate, navy, blue, teal, green, amber, gold, orange, rose, violet, gray to `globals.css`.

### Phase 3D — Tasks + notifications

- **Migration `0XXX_phase3_tasks_notifs`:** create `task_status`, `task_priority` enums, `tasks`, `notifications`. Indexes per brief.
- **Create:** `src/db/schema/tasks.ts`, `src/db/schema/notifications.ts`.
- **Create:** `src/lib/tasks.ts` (CRUD + audit), `src/lib/notifications.ts` (create + mark-read).
- **Create:** `src/app/(app)/tasks/page.tsx` — list, due-bucket grouping, inline create.
- **Create:** `src/app/(app)/tasks/_components/task-row.tsx`, `task-form.tsx`, `task-drawer.tsx`.
- **Modify:** `src/app/(app)/leads/[id]/page.tsx` — add Tasks tab.
- **Modify:** `src/app/(app)/dashboard/page.tsx` — add "My open tasks" KPI card.
- **Create:** `src/components/notifications/bell.tsx` — popover (use shadcn Popover from 3B) with unread + mark-all-read.
- **Create:** `src/app/(app)/notifications/page.tsx` — full list.
- **Create:** `src/lib/mention-parser.ts` — extract `@username` from note bodies.
- **Modify:** activities create flow (`src/lib/activities.ts`) — when `kind === "note"`, parse mentions, insert notifications.
- **Create:** `src/app/api/cron/tasks-due-today/route.ts` — bearer-auth, query open tasks, create notifications.
- **Create:** `vercel.json` — register cron entry.
- **Add env var:** `CRON_SECRET` (Vercel production).

### Phase 3E — Pipeline Kanban

- **Add deps:** `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- **Create:** `src/app/(app)/leads/pipeline/page.tsx` — server-rendered shell.
- **Create:** `src/app/(app)/leads/pipeline/_components/board.tsx` (client) — DndContext with optimistic status updates.
- **Create:** `src/app/(app)/leads/pipeline/_components/column.tsx` and `card.tsx`.
- **Create:** `src/app/(app)/leads/pipeline/actions.ts` — `updateLeadStatus(leadId, newStatus)` server action.
- **Modify:** `src/app/(app)/leads/page.tsx` — add `[Table]/[Pipeline]` toggle in header. Persist to `user_preferences.leads_default_mode` (column added in 3B prefs migration; if missed, add it here).
- **Modify:** `src/lib/leads.ts` — expose `listLeadsForPipeline()` returning grouped-by-status (capped per column).

### Phase 3F — Duplicate detection

- **Create:** `src/app/api/leads/check-duplicate/route.ts` — `GET ?email=&phone=` returning matches (id, name, company, owner, status). Permission-checked.
- **Modify:** `src/app/(app)/leads/new/_components/lead-form.tsx` — debounced blur trigger; "View matches" expandable; "Create anyway" audit-logs.
- **Modify:** `src/lib/xlsx-import.ts` — extend `email`-match dedup to also match by normalised `phone`. Reuse the "needs review" status flow.

### Phase 3G — Lead conversion + new entities

- **Migration `0XXX_phase3_records`:** create `crm_accounts` (Drizzle alias `crmAccounts`, exposed as Accounts in UI), `contacts`, `opportunities`, opportunity_stage enum. ALTER `activities` to add `account_id`, `contact_id`, `opportunity_id`, drop NOT NULL on `lead_id`, add CHECK constraint `activities_one_parent`. ALTER `tasks` similarly with `tasks_at_most_one_parent` (≤1 since unattached tasks allowed).
- **Migration `0XXX_phase3_perms_rename`:** rename `permissions.can_view_all_leads` → `can_view_all_records`. Update Drizzle schema + every consumer.
- **Create:** `src/db/schema/crm-accounts.ts`, `contacts.ts`, `opportunities.ts`. Register barrel.
- **Modify:** `src/db/schema/activities.ts`, `src/db/schema/tasks.ts` — new optional FKs.
- **Create:** `src/lib/crm-accounts.ts`, `contacts.ts`, `opportunities.ts` — CRUD + audit.
- **Create:** `src/app/(app)/accounts/page.tsx`, `[id]/page.tsx`, `new/page.tsx`, `[id]/edit/page.tsx`.
- **Create:** Same set for `/contacts/...` and `/opportunities/...`.
- **Create:** `src/app/(app)/opportunities/pipeline/page.tsx` — Kanban with 6 stages (reuse 3E primitives).
- **Create:** `src/components/lead-conversion/conversion-modal.tsx` (client).
- **Create:** `src/app/(app)/leads/[id]/convert/actions.ts` — single transaction.
- **Modify:** `src/app/(app)/leads/[id]/page.tsx` — add "Convert" button.
- **Modify:** `src/app/(app)/layout.tsx` — sidebar adds Accounts, Contacts, Opportunities.
- **Modify:** every `auth-helpers.ts` consumer that read `canViewAllLeads` to read `canViewAllRecords`.

### Phase 3H — Saved-search subscriptions + email digests

- **Migration `0XXX_phase3_subscriptions`:** `saved_search_subscriptions`.
- **Create:** `src/db/schema/saved-search-subscriptions.ts`.
- **Create:** `src/lib/digest-email.ts` — render minimal HTML.
- **Create:** `src/lib/saved-search-runner.ts` — for each sub, run filter against current records `created_at > last_seen_max_created_at`.
- **Create:** `src/app/api/cron/saved-search-digest/route.ts` — bearer-auth.
- **Modify:** `vercel.json` — second cron entry.
- **Modify:** saved view UI (in `src/app/(app)/leads/page.tsx` view header) — Subscribe button + manage modal.
- **Modify:** `/settings → Notifications` — list active subs.
- **Modify:** `src/lib/graph-email.ts` — reuse `sendMail` for digest.

### Phase 3I — Cmd+K palette + recent views

- **Migration `0XXX_phase3_recent_views`:** `recent_views` table.
- **Add dep:** `cmdk` (or rely on shadcn `Command` build-out — confirm via Context7).
- **Create:** `src/components/command-palette/command-palette.tsx` (client, global).
- **Create:** `src/lib/recent-views.ts` — upsert + trim to 50.
- **Create:** `src/app/api/search/route.ts` — `GET ?q=` returning grouped results.
- **Modify:** every detail page (`leads/[id]`, `accounts/[id]`, `contacts/[id]`, `opportunities/[id]`) — fire-and-forget upsert into `recent_views` server-side on render.
- **Modify:** `src/app/(app)/layout.tsx` — mount `<CommandPalette>` once at app shell.

### Phase 3J — Strict CSP with nonces

- **Create:** `src/middleware.ts` — generate nonce, set `x-nonce` request header, set `Content-Security-Policy` response header. (If a `proxy.ts` file exists for Next.js 16 middleware proxy — preserve.)
- **Modify:** `src/app/layout.tsx` — read `headers()` for `x-nonce`, pass via Provider to any client `<Script>` tags.
- **Modify:** `next.config.ts` — strip the `Content-Security-Policy` line from `securityHeaders` (keep the others).
- **Acceptance gate:** open every page with browser console; **zero** CSP violations.
- **If Radix style-src violations appear:** allow `'unsafe-inline'` on `style-src` ONLY. Document in `SECURITY-NOTES.md`.

### Phase 3K — Docs

- **Modify:** `README.md` — Phase 3 section.
- **Modify:** `ROADMAP.md` — strike completed items.
- **Modify:** `SECURITY-NOTES.md` — CSP changes, CRON_SECRET notes.

---

## Migration order (apply via Supabase MCP `apply_migration`)

1. `0XXX_phase3_entra_profile_fields` (3B)
2. `0XXX_phase3_user_prefs_extension` (3B)
3. `0XXX_phase3_tags` (3C)
4. `0XXX_phase3_tasks_notifs` (3D)
5. `0XXX_phase3_records` (3G)
6. `0XXX_phase3_perms_rename` (3G)
7. `0XXX_phase3_subscriptions` (3H)
8. `0XXX_phase3_recent_views` (3I)

Run `get_advisors security` and `get_advisors performance` after each. Address HIGH findings before next migration.

---

## Risks / decisions locked in

- **Auth.js `accounts` vs CRM `accounts` collision** → CRM table named `crm_accounts` in SQL/Drizzle. UI label remains "Accounts".
- **`activities.lead_id` becomes nullable** in 3G. Existing rows are unchanged (all have `lead_id` set). The CHECK constraint enforces exactly-one-parent so no row can drift to "no parent".
- **Existing `leads.tags` text[]** stays in 3C (deprecated). Drop in a follow-up.
- **CSP last** because it's invasive and breakage is hard to debug while iterating UI.
- **Email digest via Graph from user's own mailbox** — no SendGrid / Resend onboarding needed. Failure path: log + create reconnect notification, skip user.
- **Glass surfaces** stay under 8 per viewport. Form inputs and table cells stay solid (readability).
- **Theme toggle moves to /settings only** — top-bar toggle removed in 3B.

---

## Verification per phase

After each push: `list_deployments` → confirm `READY`. If `ERROR`, `get_deployment_build_logs` → fix → repush. After data migrations: `get_advisors`. After UI changes: spot-check production at https://mwg-crm.vercel.app.
