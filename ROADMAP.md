# MWG CRM — Roadmap

Items deliberately *not* tackled in Phase 2. Re-prioritise from here when planning the next round.

## Security debt (carried from Phase 2B)

- **Migrate off `xlsx`** (HIGH severity, no npm patch). Candidates: `exceljs`, the SheetJS CDN tarball (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), or SheetJS Pro. Internal admin-only feature with 10 MB cap mitigates blast radius for now.
- **Strict CSP with nonces** — replace `'unsafe-inline'` and `'unsafe-eval'` on `script-src`. Needs middleware to mint per-request nonces and threading through the Next.js app shell.
- **Upstash Redis for breakglass rate limit** — current in-memory limiter resets on Vercel cold starts. Acceptable for breakglass (rare use) but not for any future credential endpoint.
- **WebAuthn / passkeys for breakglass** instead of password.

## Phase 3 candidates (from the v2 brief, deferred)

- Visual sales pipeline (Kanban) view with drag-and-drop between status columns.
- Tasks / follow-up reminders with due dates + email notifications.
- Email templates for outbound CRM emails.
- Duplicate detection on lead create (warn if email/phone matches an existing lead).
- Tags as first-class entity with color + autocomplete.
- Outlook add-in "Track this email" button.
- Sent-items + calendar background sync via Vercel Cron.
- Lead conversion → Account / Contact / Opportunity records.
- Saved-search subscriptions + email digests.
- `/admin/imports/<id>` detail page (the Imported badge on lead detail
  links here, currently lands on `/admin/audit?action=leads.import`).

## Database performance (Supabase performance advisors)

All currently INFO-level — non-blocking. Worth revisiting when traffic warrants:

- Add covering indexes on FK columns flagged by the linter
  (`accounts.userId`, `attachments.activity_id`, `import_jobs.user_id`,
  `leads.created_by_id`, `leads.updated_by_id`, `sessions.userId`,
  `user_preferences.last_used_view_id`).
- Drop unused indexes once the workload stabilises (`leads_email_idx`,
  `leads_company_idx`, `leads_external_id_idx`, `leads_tags_gin_idx`,
  several activity / audit indexes).
