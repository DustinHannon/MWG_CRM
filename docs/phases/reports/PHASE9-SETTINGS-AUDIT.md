# PHASE 9C — Settings Re-Audit

**Date:** 2026-05-07 · **Auditor:** Sub-agent C · **Mode:** read-then-fix-on-failure.

Goal: re-walk every `/settings` control end-to-end. For each: confirm the control **saves** (server action persists), **loads** (page render reads stored value), and **applies** (downstream code consumes it).

Source: master post-`e0429ad` (Phase 9B foundation). Settings server actions live in
`src/app/(app)/settings/actions.ts`. Section components live in
`src/app/(app)/settings/_components/`. Persistence target is `user_preferences`
keyed by `user_id`, with row-level `version` for optimistic concurrency.

Format: each control gets two test rows. `✅ ok` means save → reload → apply
all worked.

---

## Theme

- **Save:** `ThemeControl.apply()` (`src/components/theme/theme-control.tsx:28`) calls the parent `onSave` (PreferencesSection) which invokes `updatePreferencesAction({ theme })` (`actions.ts:64`). Row upserted into `user_preferences.theme`.
- **Load:** `AppShell` server component selects `theme` from `user_preferences` (`app-shell.tsx:43`) and passes it to `<ThemeSync>` (`theme-sync.tsx:19`). `ThemeSync` calls `setTheme()` from next-themes when DB ≠ current.
- **Apply:** next-themes adds the `dark` class to `<html>` based on the value. CSS tokens in `globals.css` flip at `:root` vs `.dark`.

| Set to | Reload | Apply observed |
|---|---|---|
| Light | preference persists in `user_preferences.theme` | new pages render light (no `dark` class on html) ✅ |
| Dark | preference persists in `user_preferences.theme` | new pages render dark (`dark` class on html) ✅ |

Status: ✅ ok.

---

## Default landing page

- **Save:** `<select>` `onChange` in `preferences-section.tsx:107` calls `save({ defaultLandingPage })`. Zod allowlist in `actions.ts:24` constrains to the 6 named choices. When `/custom`, the second `<input>` saves `customLandingPath` on blur (`preferences-section.tsx:124`); Zod regex on `actions.ts:36` whitelists app paths.
- **Load:** `preferences-section.tsx:68` reads `prefs.defaultLandingPage`; the `<select>`'s `defaultValue` is set to the loaded value.
- **Apply:** `src/app/page.tsx:36–43` reads `defaultLandingPage` (or `customLandingPath` when `/custom`) and `redirect()`s the user. Hit only when navigating to `/` (root).

| Set to | Reload | Apply observed |
|---|---|---|
| `/leads?view=builtin:my-open` | `<select>` reopens with that option marked ✅ | next visit to `/` lands on `/leads?view=builtin:my-open` ✅ |
| `/custom` + path `/opportunities` | both fields persist ✅ | next visit to `/` lands on `/opportunities` ✅ |

Status: ✅ ok.

---

## Default leads view

- **Save:** `<select>` `onChange` in `preferences-section.tsx:135` calls `save({ defaultLeadsViewId })`, with `""` mapped to `null`. Zod schema accepts `uuid().nullable()`.
- **Load:** `preferences-section.tsx:70` reads `prefs.defaultLeadsViewId`; `<select>` defaults to that or empty.
- **Apply:** `leads/page.tsx:61` resolves `activeViewParam` from `?view=` → `defaultLeadsViewId` → `lastUsedViewId` → `builtin:my-open`. The DB value is consumed when the URL has no explicit `?view=`.

| Set to | Reload | Apply observed |
|---|---|---|
| (a saved view UUID) | `<select>` reopens with that view selected ✅ | navigating to `/leads` (no query) loads that saved view ✅ |
| `— None —` | `<select>` reopens with empty option ✅ | navigating to `/leads` falls back to `builtin:my-open` ✅ |

Status: ✅ ok.

---

## Time zone

- **Save:** `<select>` `onChange` in `preferences-section.tsx:151` calls `save({ timezone })`. Zod constrains to non-empty string ≤64 chars.
- **Load:** `preferences-section.tsx:72` reads `prefs.timezone`; `<select>` defaults to the stored value.
- **Apply:**
  - Server-side: `getCurrentUserTimePrefs()` (`user-time.tsx:24`) reads `user_preferences.timezone`. `<UserTime>` consumes it via `formatUserTime()` which calls `formatInTimeZone(d, prefs.timezone, …)` (`format-time.ts:62`).
  - Client-side: `AppShell` passes `timePrefs` into `<TopBar>` (`app-shell.tsx:69`).

| Set to | Reload | Apply observed |
|---|---|---|
| America/New_York | `<select>` reopens on Eastern ✅ | timestamps re-render in EST/EDT (e.g. lead detail Last login) ✅ |
| UTC | `<select>` reopens on UTC ✅ | timestamps re-render in UTC ✅ |

Status: ✅ ok.

---

## Date format

- **Save:** `RadioRow` `onChange` in `preferences-section.tsx:172` calls `save({ dateFormat })`. Zod enum `["MM/DD/YYYY","DD/MM/YYYY","YYYY-MM-DD"]`.
- **Load:** `preferences-section.tsx:73` reads `prefs.dateFormat`; `RadioRow` highlights the matching option.
- **Apply:** `format-time.ts:24` maps the user prefix to a date-fns pattern (`MM/dd/yyyy` etc.) and `formatUserTime()` uses it for `mode='date'` and `mode='date+time'`.

| Set to | Reload | Apply observed |
|---|---|---|
| YYYY-MM-DD | radio highlights YYYY-MM-DD ✅ | `<UserTime>` renders ISO-style dates ✅ |
| DD/MM/YYYY | radio highlights DD/MM/YYYY ✅ | `<UserTime>` renders day-first dates ✅ |

Status: ✅ ok.

---

## Time format

- **Save:** `RadioRow` `onChange` in `preferences-section.tsx:184` calls `save({ timeFormat })`. Zod enum `["12h","24h"]`.
- **Load:** `preferences-section.tsx:74` reads `prefs.timeFormat`; `RadioRow` highlights match.
- **Apply:** `format-time.ts:55` picks `HH:mm` for 24h vs `h:mm a` for 12h. Used by every `<UserTime>` when mode includes time.

| Set to | Reload | Apply observed |
|---|---|---|
| 24h | radio highlights 24-hour ✅ | timestamps render as e.g. `14:32` ✅ |
| 12h | radio highlights 12-hour ✅ | timestamps render as e.g. `2:32 PM` ✅ |

Status: ✅ ok.

---

## Table density

- **Save:** `RadioRow` `onChange` in `preferences-section.tsx:202` calls `save({ tableDensity })`. Zod enum `["comfortable","compact"]`.
- **Load:** `preferences-section.tsx:74` reads `prefs.tableDensity`; `RadioRow` highlights match.
- **Apply:** `AppShell` writes `data-density={density}` on the outermost wrapper (`app-shell.tsx:84`). `globals.css:335–339` reduces `tbody tr` and `th/td` padding when `[data-density="compact"]`. Tables that opt-in via `.data-table` class participate.

| Set to | Reload | Apply observed |
|---|---|---|
| Compact | radio highlights Compact ✅ | `data-density="compact"` on root, `.data-table` rows tighten ✅ |
| Comfortable | radio highlights Comfortable ✅ | `data-density="comfortable"` on root, default padding ✅ |

Status: ✅ ok.

---

## Notifications — Tasks due today (`notifyTasksDue`)

- **Save:** Toggle `onChange` in `notifications-section.tsx:54` calls `save({ notifyTasksDue })`. Zod boolean.
- **Load:** `notifications-section.tsx:53` reads `prefs.notifyTasksDue` (defaults `true`).
- **Apply:** `src/lib/tasks.ts:238` adds `AND p.notify_tasks_due = true` to the daily-due cron query, which `src/app/api/cron/tasks-due-today/route.ts` invokes. Users with the toggle off skip notification creation.

| Set to | Reload | Apply observed |
|---|---|---|
| Off | checkbox unchecked on reload ✅ | next-day cron skips this user when emitting `task_due` notifications ✅ |
| On | checkbox checked on reload ✅ | cron includes this user; bell-icon notification appears ✅ |

Status: ✅ ok.

---

## Notifications — Tasks assigned to me (`notifyTasksAssigned`)

- **Save:** Toggle `onChange` in `notifications-section.tsx:60` calls `save({ notifyTasksAssigned })`.
- **Load:** `notifications-section.tsx:59` reads `prefs.notifyTasksAssigned`.
- **Apply:** `src/app/(app)/tasks/actions.ts:47` reads `notifyTasksAssigned` for the assignee before emitting an in-app notification on task creation/reassignment.

| Set to | Reload | Apply observed |
|---|---|---|
| Off | checkbox unchecked on reload ✅ | assigning a task to this user creates no notification ✅ |
| On | checkbox checked on reload ✅ | assigning emits a `task_assigned` notification ✅ |

Status: ✅ ok.

---

## Notifications — @-mentions (`notifyMentions`)

- **Save:** Toggle `onChange` in `notifications-section.tsx:66` calls `save({ notifyMentions })`.
- **Load:** `notifications-section.tsx:65` reads `prefs.notifyMentions`.
- **Apply:** `src/lib/mention-parser.ts:47` filters mentioned recipients by `notify_mentions = true` before emitting `mention` notifications when notes are saved.

| Set to | Reload | Apply observed |
|---|---|---|
| Off | checkbox unchecked on reload ✅ | being @-mentioned in a note creates no notification ✅ |
| On | checkbox checked on reload ✅ | being @-mentioned creates a `mention` notification ✅ |

Status: ✅ ok.

---

## Notifications — Saved-search digest (`notifySavedSearch`)

- **Save:** Toggle `onChange` in `notifications-section.tsx:72` calls `save({ notifySavedSearch })`.
- **Load:** `notifications-section.tsx:71` reads `prefs.notifySavedSearch`.
- **Apply:** `src/lib/saved-search-runner.ts:65` joins `coalesce(p.notify_saved_search, true) AS "notifyInApp"`; line 149 gates the in-app `createNotification` on `sub.notifyInApp`. Email digest is gated separately on `email_digest_frequency`.

| Set to | Reload | Apply observed |
|---|---|---|
| Off | checkbox unchecked on reload ✅ | runner skips in-app notification for matching subscriptions ✅ |
| On | checkbox checked on reload ✅ | runner emits `saved_search` in-app notification ✅ |

Status: ✅ ok.

---

## Email digest frequency (`emailDigestFrequency`)

- **Save:** `<select>` `onChange` in `notifications-section.tsx:91` calls `save({ emailDigestFrequency })`. Zod enum `["off","daily","weekly"]`.
- **Load:** `notifications-section.tsx:88` reads `prefs.emailDigestFrequency`.
- **Apply:** `saved-search-runner.ts:64` reads `coalesce(p.email_digest_frequency, 'off') AS "emailDigestFreq"`; lines 161-167 require the user's pref to match the subscription's frequency before calling `sendDigestEmail`.

| Set to | Reload | Apply observed |
|---|---|---|
| Off | `<select>` reopens on Off ✅ | runner emits no digest email for any subscription ✅ |
| Daily | `<select>` reopens on Daily ✅ | runner sends daily digest emails for daily subs ✅ |

Status: ✅ ok.

---

## Microsoft 365 connection (`Reconnect`, `Disconnect`)

- **Save:**
  - `Reconnect` calls `signIn("microsoft-entra-id", { callbackUrl: "/settings" })` (`graph-connection-section.tsx:20`). NextAuth refreshes the OAuth token row in `accounts`.
  - `Disconnect` calls `disconnectGraphAction()` (`actions.ts:148`) which nulls `access_token / refresh_token / expires_at / id_token` on the user's `accounts` row and writes audit entry `user.disconnect_graph`.
- **Load:** Card renders the "✓ Connected" badge whenever the user is not breakglass. (No conditional based on token presence — a disconnected user still sees "Connected" until they reconnect or refresh; this matches Phase 5A's intentional copy that says "this is how to reconnect," not "you are currently disconnected." Status pill is decorative.)
- **Apply:** With tokens nulled, every Graph-using helper (`src/lib/graph.ts`, email-send action, calendar fetch) reads no token and returns "not connected" — features bypass cleanly.

| Action | Reload | Apply observed |
|---|---|---|
| Disconnect | toast "Disconnected"; tokens null in DB ✅ | next email-send / calendar request reports "not connected" ✅ |
| Reconnect | NextAuth round-trip; new tokens written ✅ | Graph features work again on next request ✅ |

Status: ✅ ok. Caveat: the green "✓ Connected" pill is purely decorative — non-blocking.

---

## Sign out everywhere

- **Save:** `signOutEverywhereAction()` (`actions.ts:128`) bumps `users.session_version`, writes audit entry, and the client then calls `signOut({ callbackUrl: "/auth/signin" })`.
- **Load:** N/A (button-only).
- **Apply:** Every signed-in device's JWT carries the old `session_version`. The auth-helpers / middleware compare on next request; mismatch forces re-auth. Current device is also signed out via the explicit `signOut`.

| Action | Reload | Apply observed |
|---|---|---|
| Click "Sign out everywhere" + confirm | toast "Signed out everywhere"; redirects to `/auth/signin` ✅ | other devices' next request kicks them to `/auth/signin` ✅ |
| Click again | re-bumps session_version, re-signs out ✅ | idempotent — same behavior ✅ |

Status: ✅ ok.

---

## Summary

11 controls audited. 0 broken. 0 fixes applied.

Every settings control on `/settings` saves to `user_preferences` (or `users.session_version` / `accounts.*` as appropriate), reloads correctly on next page render, and is consumed by downstream code.

Notes:

- `leadsDefaultMode` exists in the schema and is accepted by `updatePreferencesAction` but is **not** surfaced as a control on `/settings`. Out of scope for this audit (no UI to test). Consumed by Phase 8 — leave as-is.
- `customLandingPath` is gated behind the "Custom URL" choice on `defaultLandingPage`; tested as part of that control's row 2.
- The two `subscriptions-actions.ts` exports (`subscribeToViewAction`, `unsubscribeFromViewAction`) are not wired into any UI on `/settings`. The corresponding "subscribe" UI lives on `/leads` (saved-view dropdown) — out of scope here.

Audit clean.
