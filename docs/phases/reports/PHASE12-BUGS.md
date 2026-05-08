# Phase 12 — Bug ledger

> One row per finding. Sub-A appends concurrency / theme / logic-drift
> findings; Sub-B appends mobile findings; Sub-C appends test failures.
>
> Severity: **HIGH** = data integrity / privilege escalation;
> **MED** = user-visible incorrectness or noisy UX;
> **LOW** = cosmetic / minor.
>
> Status: **open / fix-in-progress / fixed (commit) / accepted (link)
> / deferred (BACKLOG-PHASE13.md)**.

| ID | Severity | Source | Title | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| BUG-001 | MED | inventory §3 | `updateActivity` has no `version` / OCC; concurrent edits silently last-write-wins | open | Sub-A | Add `version` column or accept |
| BUG-002 | MED | inventory §3 | No client-side submission lock on create forms (lead/account/contact/opportunity/task) — double-submit risk | open | Sub-A | Most `<form>` likely already disable on pending; verify |
| BUG-003 | MED | inventory §3 | Undo-toast token can fire after admin hard-deletes the record | open | Sub-A | Token consumer should treat NotFound as no-op |

---

End of seed. Sub-agents append below.
