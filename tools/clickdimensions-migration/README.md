# ClickDimensions migration script

Phase 29 §7 — Standalone Playwright-driven extractor that walks the
legacy ClickDimensions email-template surface in Dynamics 365 and
mirrors each template into MWG CRM as a `marketing_templates` row
with `source='clickdimensions_migration'`.

The script is intentionally outside `src/` so it never ships in the
production bundle. It runs on a workstation (or `AZ-UTIL-AICHAT`)
with a headed browser. The operator completes sign-in + MFA
interactively the first time, and the resulting auth state is reused
across subsequent runs until D365 invalidates the session.

## Setup

```bash
cd tools/clickdimensions-migration
npm install
npx playwright install chromium
cp .env.example .env
# Fill in MWG_API_KEY (generate at /admin/api-keys with scope
# marketing.migrations.api) and CD_BASE_URL.
```

## Auth (once per session lifetime)

```bash
npm run auth
```

A Chromium window opens; sign in, complete MFA, navigate to
ClickDimensions → Messaging → Templates so the list is visible, then
press Enter on the terminal. The script saves `storage.json` and
exits. Treat `storage.json` like a credential — do not commit, do
not share.

## Extract

```bash
# Full run.
npm run extract

# Dry-run / first iteration — process at most N templates.
npm run extract -- --limit 5
```

Concurrency is 1 by design. Per-template timeout is 60s. Progress is
written to `extraction-state.json` after every row so a crash or
session-expiry can be resumed without re-walking what was already
posted.

The extractor POSTs each template to MWG CRM. The receiving endpoint
is idempotent on `cd_template_id`, so re-running the script is safe.
Successful extractions also create a `marketing_templates` row with
`scope='global'` and a `[CD]` name prefix.

## Re-auth

If the script logs `session_expired`:

```bash
rm storage.json
npm run auth
npm run extract
```

The state file (`extraction-state.json`) preserves which templates
have already been processed, so the resumed run skips them locally
in addition to the server-side idempotency.

## Failure diagnosis

Open `/admin/migrations/clickdimensions` in MWG CRM. Each row shows:

- Status pill (`pending`, `extracted`, `imported`, `failed`, `skipped`)
- Attempts counter
- `error_reason` for failures
- "View HTML" button for inspecting captured payloads

For rows the extractor cannot handle (e.g. an editor variant the
handlers don't recognize), use the row's "Skip" action to record a
fallback-manual audit event, then migrate the template by hand in
the main MWG template editor.

## Manual fallback

If the extractor consistently fails on a template:

1. Click "Skip" on the worklist row (logs
   `marketing.template.migration.fallback_manual`).
2. Open the legacy template in ClickDimensions; copy the HTML.
3. Go to `/marketing/templates/new` in MWG CRM, paste into the
   editor's HTML pane, save.

## Repository policy

This directory is governed separately from the main app:

- `package.json` is standalone. The main app's `pnpm-lock.yaml` is
  not touched.
- `storage.json`, `extraction-state.json`, and `.env` are gitignored.
- The script is launched manually by an operator; there is no cron,
  no CI step, no Vercel build.
