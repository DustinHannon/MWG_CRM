# Known concurrency races (accepted)

> When a concurrency finding from the Phase 12 review is **acknowledged
> but explicitly NOT fixed**, document it here with reasoning so the
> team has a record. A future engineer can revisit this list when the
> trade-off changes.

Format per entry:

```
### <one-line description>
**Severity:** LOW / MED
**Where:** <file:line or feature>
**Reason for acceptance:** <why the cost of fixing exceeds the benefit>
**Re-evaluate when:** <condition that would flip the decision>
**Linked bug:** PHASE12-BUGS.md#BUG-XXX
```

---

(empty — Phase 12 review is in progress; entries land here only after
Sub-A finishes the audit and the team explicitly decides to accept a
finding.)
