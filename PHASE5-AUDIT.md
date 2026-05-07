# PHASE5-AUDIT.md — running audit log

## Phase 5A — `/settings` end-to-end audit (2026-05-07)

**Method:** for every settings control, walk three legs (saved on change?, read on load?, applied to user-visible behavior?). Results below.

| Control                       | Storage column                                | Save | Read | Apply | Notes |
|-------------------------------|-----------------------------------------------|:---:|:---:|:---:|---|
| Theme                         | `user_preferences.theme`                      | ✅  | ❌  | ❌  | Root layout hardcodes `className="dark"`. `next-themes` is in `package.json` but no `ThemeProvider` is mounted anywhere. |
| Default landing — preset      | `user_preferences.default_landing_page`       | ✅  | ❌  | ❌  | No middleware/proxy redirect from `/` to the chosen path. |
| Default landing — custom      | `user_preferences.custom_landing_path`        | ✅  | ❌  | ❌  | Same — column saved but never consulted at request time. |
| Default leads view            | `user_preferences.default_leads_view_id`      | ✅  | ❌  | ❌  | `/leads/page.tsx` uses `lastUsedViewId` only; never reads `default_leads_view_id`. |
| Time zone                     | `user_preferences.timezone`                   | ✅  | ❌  | ❌  | 21 files call raw `toLocaleString` / `formatDistanceToNow`; pref is ignored. |
| Date format                   | `user_preferences.date_format`                | ✅  | ❌  | ❌  | Same. |
| Time format                   | `user_preferences.time_format`                | ✅  | ❌  | ❌  | Same. |
| Table density                 | `user_preferences.table_density`              | ✅  | ❌  | ❌  | No code reads it; no `data-density` attribute on `<html>`; no CSS. |
| Notify: tasks due today       | `user_preferences.notify_tasks_due`           | ✅  | ✅  | ✅  | `tasks-due-today` cron filters via SQL JOIN. |
| Notify: tasks assigned        | `user_preferences.notify_tasks_assigned`      | ✅  | ✅  | ✅  | `createTaskAction` reads pref before creating notification. |
| Notify: @-mentions            | `user_preferences.notify_mentions`            | ✅  | ✅  | ✅  | `filterMentionsByPref` is called from activities.ts. |
| Notify: saved-search digest   | `user_preferences.notify_saved_search`        | ✅  | ❌  | ❌  | `saved-search-runner.ts` creates the in-app `saved_search` notification unconditionally — never reads the pref. |
| Email digest frequency        | `user_preferences.email_digest_frequency`     | ✅  | ✅  | ✅  | Runner reads `email_digest_frequency` and gates `sendDigestEmail` on it. |
| Sign out everywhere           | (action — bumps `users.session_version`)      | n/a | n/a | ✅  | Action correctly bumps `session_version`; `auth.ts` jwt callback Case 3 enforces it. |
| Entra profile photo (display) | `users.photo_blob_url`                        | n/a | ✅  | ❌  | UI reads it (Avatar primitive); but `users.photo_blob_url` is never populated. |
| Entra profile photo (refresh) | `users.photo_synced_at`                       | n/a | ❌  | ❌  | `refreshUserPhotoIfStale` exists in `src/lib/graph-photo.ts` but is **never called from anywhere** in the codebase (`grep` confirms zero call sites). |

### Root causes (action items)

1. **Theme** — no `next-themes` `ThemeProvider`; root `<html>` has `dark` hardcoded.
   → Mount `ThemeProvider` in root layout; remove `dark` hardcode; add `<ThemeSync prefs.theme>` client component to push DB pref into next-themes on mount.

2. **Default landing** — `proxy.ts` does cookie-presence + CSP only. No redirect logic for `/`.
   → Extend proxy: when `pathname === '/'` and authed, look up `user_preferences.custom_landing_path` (or `default_landing_page` if `/custom` not selected) and 307 to it. Allowlist routes to prevent open-redirect.

3. **Default leads view** — `getPreferences` returns `lastUsedViewId`; the page never asks for `default_leads_view_id`.
   → Have `getPreferences` return `defaultLeadsViewId` too; in the page resolver, prefer `default_leads_view_id` over `last_used_view_id` when no `?view=` param is present.

4. **Time zone / date format / time format** — no `<UserTime>` primitive exists.
   → Build `<UserTime>` server component on `date-fns-tz formatInTimeZone` + `formatDistanceToNow`. Replace raw calls in the 21 files identified.

5. **Table density** — no consumer.
   → Authenticated layout reads prefs and stamps `data-density="..."` on `<html>` (or root `<div>`). Add CSS rules in `globals.css`. Apply `.data-table` className across data tables.

6. **Notify: saved-search** — runner unconditionally creates the in-app notification.
   → Add a `notify_saved_search` predicate to the SQL or a per-sub check before `createNotification(... kind: "saved_search" ...)`.

7. **Entra photo** — refresher exists but no call sites.
   → Call `refreshUserPhotoIfStale(userId)` from `auth.ts` jwt callback Case 1 (Entra initial mint), right after `upsertAccount`. Wrap in try/catch — non-critical.

### Phase 5A — fixes shipped (2026-05-07 push 1)

| Fix | File(s) |
|---|---|
| `next-themes` ThemeProvider mounted; root `dark` hardcode removed | `src/app/layout.tsx`, `src/components/theme/theme-provider.tsx` |
| `<ThemeSync>` reconciles next-themes to DB pref on every authed page | `src/components/theme/theme-sync.tsx`, `src/app/(app)/layout.tsx` |
| `<ThemeControl>` settings toggle drives both DB + next-themes; reverts on save failure | `src/components/theme/theme-control.tsx`, `src/app/(app)/settings/_components/preferences-section.tsx` |
| Entra photo refresh wired into auth jwt callback (Case 1, after `upsertAccount`) | `src/auth.ts` (calls existing `refreshUserPhotoIfStale`) |
| Custom landing applied at `/` redirect (allowlist baked into Zod on save side) | `src/app/page.tsx` |
| Default leads view honored over `last_used_view_id` | `src/lib/views.ts`, `src/app/(app)/leads/page.tsx` |
| Saved-search digest in-app notification respects `notify_saved_search` | `src/lib/saved-search-runner.ts` |
| Table density `data-density` attribute on app shell + CSS rules + `.data-table` className on every data table | `src/app/(app)/layout.tsx`, `src/app/globals.css`, all 8 data-table sites |
| `formatUserTime` helper + `<UserTime>` server component + `<UserTimeClient>` for client | `src/lib/format-time.ts`, `src/components/ui/user-time.tsx`, `src/components/ui/user-time-client.tsx` |
| `<UserTime>` rollout to user-visible timestamp surfaces | settings/account-info, dashboard, leads list, leads detail, archived leads, accounts list, opportunities list, opportunities detail, notifications page + bell, tasks list, audit log, admin users, admin tags, activity feed, print-page |

### Items NOT shipped in 5A push 1 (deferred)

- `convert-modal.tsx` — uses `new Date().toLocaleDateString()` for a UI default suggestion; unaffected by user-prefs because it's not a record timestamp. Left as-is.
- `accounts/[id]/page.tsx` — only currency formatting, no timestamps.
- Pipeline boards (leads, opportunities) — only currency formatting, no timestamps.
- Sign-out-everywhere two-browser cross-test — code path verified, manual two-browser test pending.

### Files known to need `<UserTime>` rollout

(from grep `toLocaleString|toLocaleDateString|toLocaleTimeString|formatDistanceToNow|date-fns`)

- `src/app/(app)/leads/[id]/page.tsx`
- `src/app/leads/print/[id]/page.tsx`
- `src/app/(app)/leads/archived/page.tsx`
- `src/components/leads/score-badge.tsx`
- `src/app/(app)/dashboard/page.tsx`
- `src/app/(app)/opportunities/[id]/page.tsx`
- `src/app/(app)/accounts/[id]/page.tsx`
- `src/app/(app)/opportunities/pipeline/_components/board.tsx`
- `src/app/(app)/opportunities/page.tsx`
- `src/app/(app)/accounts/page.tsx`
- `src/app/(app)/leads/[id]/convert/_components/convert-modal.tsx`
- `src/app/(app)/leads/page.tsx`
- `src/app/(app)/leads/pipeline/_components/board.tsx`
- `src/app/(app)/notifications/page.tsx`
- `src/components/notifications/bell.tsx`
- `src/app/(app)/tasks/_components/task-list-client.tsx`
- `src/app/admin/tags/_components/tags-admin-table.tsx`
- `src/app/(app)/settings/_components/account-info-section.tsx`
- `src/app/admin/users/page.tsx`
- `src/app/admin/audit/page.tsx`
- `src/app/(app)/leads/[id]/activities/activity-feed.tsx`
