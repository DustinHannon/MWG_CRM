# PLAN — Phase 9

UI improvements (profile pictures + sticky sidebar + clickable user profiles),
CRM workflow verification, settings/permissions wiring re-audit, database
scale prep. **No new CRM features.**

Production: https://mwg-crm.vercel.app · Branch: master · No PRs.

---

## Threads (seven)

1. **Profile pictures everywhere** a user appears (lists, detail rows, activity authors, mention chips, admin users).
2. **Clickable user profiles** — hover → tooltip; click → `/users/[id]`.
3. **Sticky left sidebar** — sidebar fixed, only main scrolls.
4. **CRM workflow verification** — Lead → Qualify → Account+Contact+Opportunity, plus direct-entry paths.
5. **Login refresh hardening** — every Entra sign-in pulls fresh photo/name/title/email/manager/dept.
6. **Settings + permissions wiring audit** — kill fake permissions; verify every settings control.
7. **Database scale prep** — cursor pagination, indexes, query optimisation for 100k leads + 80 concurrent users.

## Out of scope (explicit)

- New CRM features (forecasting, calendar sync, manager linking, mobile, custom fields).
- Schema changes other than indexes + permission flag adjustments.
- Re-design — AppShell stays canonical, this phase enhances it.
- Phase 8 deferral list — none of those land here.

---

## Sequencing

```
9A  audits          (lead, serial, READ-ONLY)
       ├─ PHASE9-WORKFLOW-AUDIT.md
       └─ PHASE9-PERMISSIONS-AUDIT.md

9B  foundation      (lead, serial)
       ├─ Sticky AppShell
       ├─ <UserAvatar>, <UserChip>, <UserHoverCard>
       └─ /users/[id] page + getUserProfileSummary / getUserProfilePage

9C  parallel sub-agents (Task dispatch)
       ├─ A — profile-picture proliferation
       ├─ B — workflow gap fixes (default views, direct-entry, customer-since)
       ├─ C — permissions wiring + settings re-audit
       └─ D — database scale prep (cursor pagination, indexes)

9D  login refresh   (lead, serial)
9E  smoke test      (lead, serial)
9F  PHASE9-REPORT.md
```

## Acceptance gates

- `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build` green.
- Production deployment green.
- Browser console: zero CSP violations on every authenticated route.
- Supabase `get_advisors` (security + performance): no HIGH.

## Operating principles

- Plan first; no surprise abstractions.
- Verify before changing. Especially workflow + permissions audits.
- Small atomic commits. Sub-agents push their own.
- Don't redesign — enhance.
