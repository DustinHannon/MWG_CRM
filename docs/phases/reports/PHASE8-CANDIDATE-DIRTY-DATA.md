# Phase 8 — Candidate Test/Fake Data

For user review in §8E cleanup. DO NOT delete without per-category confirmation.

Auditor: Sub-agent B (read-only SQL via Supabase MCP)
Method: Pattern matching against live data, project ylsstqcvhkggjbxrgezg
Date: 2026-05-07

## Headline finding

**The production database is essentially empty of business data.** Across leads / activities / tasks / contacts / crm_accounts / opportunities / tags / lead_tags / attachments / import_jobs / notifications / saved_search_subscriptions / recent_views / lead_scoring_rules — **all are zero rows**.

There is therefore nothing to clean up in those tables. Either:
- (a) Phase 6 import test data was already cleaned up, or
- (b) the import test was rolled back and never persisted, or
- (c) data was wiped after Sub-agent A's UI testing this afternoon (audit_log doesn't show a wipe action — last admin action was `user.breakglass_rotated` at 20:20 UTC).

The user should confirm which is the case before considering §8E "complete".

## Category 1 — Definitely test data, safe to remove

| Table | Match pattern | Count |
|---|---|---|
| leads | `lower(first_name|last_name) ~ '(test|fake|asdf|qwerty)'` | 0 |
| leads | `email ~ '@(example|test)\.com$'` | 0 |
| leads | `email ~ '^(test|fake)@'` | 0 |
| leads | `external_id LIKE 'phase6-test%'` | 0 |

**Nothing to clean up.**

## Category 2 — Probably test data, ask user

| Table | Match pattern | Count |
|---|---|---|
| leads | empty (email/phone/company/city all NULL) | 0 |
| leads | duplicate (first_name, last_name, email) | 0 |
| audit_log | `action = 'import.commit'` | 0 |

**Nothing to clean up.** No Phase 6 import commit ever wrote to `audit_log`, so the import test path was either rolled back or never ran against this DB.

## Category 3 — Non-lead test artifacts

| Table | Match pattern | Result |
|---|---|---|
| saved_views | `name ~* '(test|asdf|fake)'` | 0 |
| tags | `name ~* '(test|asdf|fake)'` | 0 (table empty) |
| tasks | `title ~* '(test|asdf|fake)'` | 0 (table empty) |

The single `saved_views` row is named "My All Columns" (created 2026-05-07 15:39 UTC by `dustin.hannon@morganwhite.com`, scope `mine`, pinned). **Looks like a real user view, NOT test data — leave alone.**

## Category 4 — Audit log (do not delete; append-only)

Counts only — these rows must be preserved for audit history:
- audit_log entries from Phase 6 import test: **0**
- audit_log entries from "test" admin actions: **0** (no `*.test*` action labels)
- audit_log entries total: **14**, all of which are legitimate user/admin lifecycle events:
  - 1 × `user.promote_to_admin` (Phase 2E bootstrap, Dustin)
  - 1 × `user.force_reauth` (Dustin)
  - 1 × `user.breakglass_rotated` (Dustin rotated breakglass password)
  - 1 × `view.create` ("My All Columns")
  - 10 × `user_preferences.update` (theme toggles between light/dark for Dustin's settings — verifying Phase 5A theme toggle persistence)

## Recommendation

§8E ("Cleanup test/fake data") has no work items in the database. If Sub-agent A is mid-test and is creating data in real time, re-run this audit at the end of Phase 8 before any cleanup migration is built.

If the user expected Phase 6 import test leads to be present (113-lead test batch per PHASE6-IMPORT-TEST), they are NOT in production. Investigate where they went — possible the test branched/rolled back, possible they were already manually cleaned, or possible the Phase 6 import test ran against a separate Supabase branch/environment.
