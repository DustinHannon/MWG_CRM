# MWG CRM — Roadmap

Items deliberately *not* tackled this phase. Re-prioritise from here when planning the next round.

## Security debt

- **Migrate off `xlsx`** (HIGH severity, no npm patch). Candidates: `exceljs`, the SheetJS CDN tarball, or SheetJS Pro. Internal admin-only feature with 10 MB cap mitigates blast radius for now.
- **CSP `style-src 'unsafe-inline'`** — strict CSP with nonces shipped in Phase 3J, but style-src still allows `'unsafe-inline'` because shadcn/Radix and react-hook-form inject styles at runtime. Tightening would require deep framework integration.
- **`'unsafe-eval'` on script-src** — kept for runtime libraries; can probably be removed once we audit which dependency uses eval.
- **Upstash Redis for breakglass rate limit** — current in-memory limiter resets on Vercel cold starts. Acceptable for breakglass (rare use) but not for any future credential endpoint.
- **WebAuthn / passkeys for breakglass** instead of password.
- **CSP violation reporting** — point `report-uri` somewhere so we can see real-world failures.

## Phase 3 follow-ups (intentionally deferred or partial)

- **Saved-view subscribe button on the views toolbar.** Server actions exist (`subscribeToViewAction`, `unsubscribeFromViewAction`); UI integration into `view-toolbar.tsx` and a subscriptions list section in `/settings → Notifications` is incremental work on top.
- **Lead-detail Tasks tab + dashboard "My open tasks" widget.** `/tasks` page is live and tasks attach to leads in the schema; surfacing tasks on the lead-detail page and dashboard is incremental.
- **Lead create/edit form — switch to TagInput.** TagInput component shipped (used in /admin/tags); the create/edit form still uses the legacy `text[]` tags field. Replace and remove `leads.tags text[]` after burn-in.
- **Drop `leads.tags text[]`** once nothing reads it.
- **Import phone-match dedup.** XLSX import already does email-match needs-review; phone-match extension is the same pattern.
- **Account / Contact / Opportunity create + edit pages.** Detail pages are live; entities created via lead conversion. Standalone create/edit forms for these entities are the next surface.
- **Opportunity tabs** (Activities / Contacts / Files / Tasks) — detail page renders a single Details card; activity composer adapter is incremental.
- **Outlook add-in** ("Track this email" button). Deferred — non-trivial.
- **Outlook calendar background sync.** Deferred — out of scope for Phase 3.

## Database performance (Supabase performance advisors)

All currently INFO-level — non-blocking.

- Add covering indexes on FK columns flagged by the linter.
- Drop unused indexes once the workload stabilises.

## RLS

All public tables have RLS enabled with no policies. The app uses a custom Postgres role (`mwg_crm_app`) with `BYPASSRLS`. Defence-in-depth, not the primary access control. If the role is ever changed, RLS becomes a hard wall — desired.
