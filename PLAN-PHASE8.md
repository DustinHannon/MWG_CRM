# PLAN-PHASE8.md — MWG CRM Phase 8 (Forensic audit + cleanup)

> Phase 8 is a **non-feature phase**. Goal: prove every claim from Phases 1–7 is real, fix what isn't, remove decay, and produce an evidence-backed final report. No new features. No design changes.

---

## Goals

1. **Forensic audit.** Verify every "feature X ships" claim from Phases 1–7 against the actual codebase + database + production runtime. Fabrications, half-built surfaces, and code/doc drift get logged, not glossed over.
2. **Cleanup.** Dead code, orphaned files, unreferenced exports, stale TODOs, contradictory docs. Remove decay accumulated across seven phases of forward motion.
3. **Evidence trail.** Every fix has a finding ID. Every finding cites a file path + line range or DB query. Every "passed" claim has a witness (test run, screenshot, SQL result, or audit-log entry).

What Phase 8 explicitly does **not** do:
- Ship deferred features (see `PHASE8-DEFERRED.md`).
- Refactor for taste — only for correctness and consistency with existing patterns.
- Touch destructive operations (production data delete, schema drops) without explicit user confirmation in 8E.

---

## Phase shape

```
8A  Inventory          ── claims master list + deferred list (this commit)
8B  Audit (parallel)   ── 5 sub-agents, read-only, write reports A–E
8C  Consolidation      ── merge + deduplicate findings → fix plan
8D  Fixes (parallel)   ── ship fixes by severity, push to master per chunk
8E  Destructive cleanup ── user-confirmed dead-code/dead-table removal
8F  Smoke              ── full re-test of fixed surfaces + regression sweep
8G  Final report       ── PHASE8-REPORT.md + ROADMAP/README updates
```

### 8A — Inventory (this commit)
Outputs:
- `PHASE8-CLAIMS.md` — every concrete claim from Phases 1–7, grouped by area.
- `PHASE8-DEFERRED.md` — verbatim deferred-by-design list. Auditors do not flag items on this list.
- `PLAN-PHASE8.md` — this document.

### 8B — Audit (5 parallel sub-agents)
Each sub-agent reads `PHASE8-CLAIMS.md` + `PHASE8-DEFERRED.md` and a slice of the codebase + DB + runtime. Sub-agents are **read-only**: they do not edit code, push to git, or apply migrations. Each writes exactly one file: `PHASE8-AUDIT-{LETTER}.md`.

| Agent | Surface | Mandate |
|---|---|---|
| **A — Auth, Session, Security** | `src/auth.ts`, `src/proxy.ts`, `src/lib/auth-helpers.ts`, `src/lib/access.ts`, `src/lib/breakglass.ts`, `src/lib/entra-provisioning.ts`, `src/lib/graph-token.ts`, `src/lib/graph-photo.ts`, `next.config.ts`, headers, CSP nonces, rate limits, IDOR gates | Verify auth claims; trace every claim to code; run live `curl` of CSP headers from prod. |
| **B — Data Layer + Migrations** | `src/db/schema/**`, `drizzle/**`, `src/lib/db/concurrent-update.ts`, all migrations, FK rules, CHECK constraints, RLS state, indexes, version columns, soft-delete columns, FTS indexes | Run live SQL via Supabase MCP `execute_sql` to confirm columns/constraints/indexes match claims. Run `get_advisors` security + performance. |
| **C — Server Actions + Routes** | `src/app/**/actions.ts`, `src/app/api/**/route.ts`, server-action discipline (Zod input, OCC, access gates, `withErrorBoundary`, audit writes, no `console.*`) | Walk every action/route. Confirm 6-point discipline checklist per action. Catch missing gates, missing audit, bare `db.update`. |
| **D — UI surfaces + Settings** | `src/app/(app)/**`, `src/app/admin/**`, `src/components/**`, `/settings` end-to-end, theme/timezone/density/notifications/sign-out-everywhere, Cmd+K, Kanban, tags UI, glass tokens, AppShell, `<UserTime>` rollout | Trace every UI claim. Spot-check via Playwright on production. Compare PHASE5-AUDIT findings to current code. |
| **E — Import + Cron + Graph** | `src/lib/import/**`, `/api/cron/**`, `src/lib/graph-*.ts`, `src/app/(app)/leads/import/**`, smart-detect, dedup keys, idempotent re-import, owner/by-name resolution, cron auth, send-mail, schedule-meeting | Confirm import pipeline behavior with synthetic fixture run. Verify cron entries in `vercel.json`. Trace Graph endpoint usage. |

#### Sub-agent contract

Each sub-agent:
1. Reads `PHASE8-CLAIMS.md`, `PHASE8-DEFERRED.md`, and only their assigned surface.
2. Writes exactly one file: `PHASE8-AUDIT-{LETTER}.md`. No other writes.
3. Never pushes to git, applies migrations, or runs destructive operations.
4. May read DB via Supabase MCP, read deployment logs via Vercel MCP, read production HTML via Playwright, but does not write.
5. May invoke `pnpm tsc --noEmit`, `pnpm lint`, `pnpm build` (read-only verification).
6. Output format per finding:
   ```
   ### F-{letter}{number} — {short title}
   - Claim: [Phase X] <verbatim from PHASE8-CLAIMS.md>
   - Severity: P0 | P1 | P2 | P3
   - Evidence: <file:line, SQL output, screenshot, log line>
   - Verdict: pass | partial | fail | fabricated | drift
   - Fix recommendation: <one paragraph; reference exact file/line>
   ```

#### Severity definitions

- **P0 — Production-breaking or security-impacting.** Must fix before declaring Phase 8 complete. Examples: unauthenticated server action, missing access gate on detail route, secret in logs, RLS bypass, broken auth flow.
- **P1 — Data integrity or trust-of-platform.** Examples: claimed feature non-functional, OCC missing on a stated path, audit-log entry missing for a documented mutation, claimed migration not applied.
- **P2 — Decay / drift.** Examples: dead code, dangling imports, stale comments, doc/code mismatch on non-critical surface, console.log left in committed code.
- **P3 — Cosmetic / nice-to-have.** Examples: JSDoc gaps on internal helpers, minor wording in admin UI. Logged but may be deferred to next phase.

### 8C — Consolidation
Lead agent reads all five `PHASE8-AUDIT-*.md` files, deduplicates findings, sorts by severity, and writes:
- `PHASE8-FINDINGS.md` — flat ordered list of unique findings with global IDs (F-001..F-NNN).
- `PHASE8-FIX-PLAN.md` — fix order grouped by file ownership (so 8D parallelism doesn't collide), plus dependency ordering (e.g., schema fix before action fix that depends on it).

### 8D — Fixes (parallel)
Lead dispatches fix work in parallel along **disjoint file ownership** boundaries. Each fix worker:
1. Pulls a slice of `PHASE8-FIX-PLAN.md` scoped to a non-overlapping file set.
2. Applies fixes, references finding IDs in commit messages.
3. Pushes to master after each chunk; verifies Vercel deploy green.
4. Updates the relevant finding in `PHASE8-FINDINGS.md` to `status: fixed in <commit>`.

P0 fixes ship first, serially (no parallelism for security-impacting work — single set of eyes per fix). P1/P2 ship in parallel where files are disjoint. P3 may roll forward to Phase 9.

### 8E — Destructive cleanup (USER-CONFIRMED)
Anything that deletes data, drops columns, drops tables, drops indexes, or removes files Lead has not authored requires **explicit user confirmation in chat** before execution. The lead surfaces:
- A diff of what will be removed.
- Why it's safe (dead-code analysis, zero references, zero rows, etc.).
- Rollback plan (git revert or DB migration up).

User answers "yes" → execute. User answers "no" or asks for changes → adjust and re-surface. Never execute on assumed consent.

### 8F — Smoke
Lead reruns the canonical smoke surfaces:
- `pnpm tsc --noEmit && pnpm lint && pnpm build` clean.
- Vercel deploy green; runtime logs (24h, error+warning+fatal): zero new entries.
- Supabase advisors: no new HIGH findings vs Phase 7 baseline.
- Two-tab OCC test on lead edit (per `PHASE6-OCC-TEST.md`).
- Synthetic import fixture run (per `PHASE6-IMPORT-TEST.md`).
- `/leads`, `/dashboard`, `/admin/users`, `/settings`, `/leads/[id]` Playwright screenshots in light + dark; compared against Phase 7 baseline.

### 8G — Final report
`PHASE8-REPORT.md`:
- Headline: `N findings, M fixed, K deferred to Phase 9, 0 unaddressed P0`.
- Per-area pass/partial/fail count.
- List of fabricated claims (if any), with the doc that claimed them.
- List of dead code removed.
- List of contradictory docs reconciled.
- Updated `ROADMAP.md` reflecting deferred items.
- Updated `README.md` Phase 8 section.
- Final commit links.

---

## Forbidden zones

- No auditor (8B) pushes to master, applies migrations, deploys, runs destructive SQL, or modifies code.
- No auditor edits another auditor's report.
- 8E destructive operations require explicit user confirmation per item; no batch consent.
- Lead agent does not bypass auditor findings; each finding is either fixed, explicitly accepted (with rationale in `PHASE8-FINDINGS.md`), or deferred (with ROADMAP.md entry).
- No "while we're here" feature additions. Anything that is not on the audit→fix→cleanup path waits for Phase 9.
- `SECURITY-NOTES.md` and `ARCHITECTURE.md` are sources of truth — if a fix changes behavior they document, the doc updates in the same commit.

---

## Acceptance criteria

Phase 8 is complete when **all** of the following are true:

1. Five audit reports exist: `PHASE8-AUDIT-A.md` through `PHASE8-AUDIT-E.md`.
2. `PHASE8-FINDINGS.md` exists with every audit finding consolidated, deduplicated, and assigned a global ID.
3. `PHASE8-FIX-PLAN.md` exists and every entry maps to either:
   - a commit that fixed it (status: fixed), or
   - a `ROADMAP.md` entry deferring it with rationale (status: deferred), or
   - an explicit "accepted risk" entry with rationale (status: accepted).
4. **Zero P0 findings unaddressed.** Every P0 must be `fixed` or `accepted` (no "deferred" status allowed for P0).
5. 8E destructive cleanup complete: every per-item user-confirmed delete executed; Lead's surfaced diff matches the actual removal.
6. 8F smoke green:
   - `pnpm tsc --noEmit && pnpm lint && pnpm build` clean.
   - Vercel deploy READY; latest commit live.
   - Runtime logs 24h: zero error/warning/fatal entries from new code.
   - Supabase advisors: zero new HIGH; existing advisors documented and unchanged.
   - Two-tab OCC test: conflict toast on second save, no regression on first.
   - Import synthetic fixture run: matches expected counts.
7. `PHASE8-REPORT.md` posted with the headline numbers and links to every artifact above.
8. `ROADMAP.md` updated to reflect what shipped vs deferred in Phase 8.
9. `README.md` Phase 8 section added (one paragraph, scannable).

---

## Scope reminders

- Auditors flag a feature only if it is **not** on the deferred list and **not** present/working in the codebase. Things on `PHASE8-DEFERRED.md` are correct-by-design absences.
- Doc/code drift is a finding, not a wave-of-the-hand. Either the doc is wrong (fix it) or the code is wrong (fix it). The team chose master-only push-and-deploy precisely so source of truth lives in code.
- "Works on my machine" is not evidence. Witness must be a file path + line, a SQL result, a deploy log, a screenshot, or an audit-log entry.
- Deferred-by-design (see `PHASE8-DEFERRED.md`) means the absence is documented and accepted; auditors never escalate these.
