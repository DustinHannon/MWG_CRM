# Phase 6H — import smoke test

> The brief specified a smoke against the user's real production export
> file `mwg-crm-leads-batch-0447.xlsx`. That file was not present in the
> workspace at the time of Phase 6H, so this document covers two things:
>
> 1. **Synthetic-file smoke** — exercises every code path with fixtures
>    matching the production shape. Result captured below; reproducible
>    via `pnpm dlx tsx scripts/import-smoke-run.ts`.
> 2. **Production-file smoke** — instructions for running the full
>    pipeline end-to-end against the real file once it's available.
>    Document the result by appending to this file.

## 1. Synthetic-file smoke

### Fixture builder

`scripts/import-smoke-build.ts` writes
`./test-data/mwg-crm-leads-batch-synthetic.xlsx` with eight rows that
exercise every code path:

| Row | Persona | Tests |
|---|---|---|
| 2 | Bettina Overbeck | Topic + 2 calls + 1 meeting (with attendees + duplicate dedup), D365 status `Qualified` mapping |
| 3 | John Costanzo "Snarky" | Topic + Linked Opportunity + 1 call (the canonical 6D smart-detect case) |
| 4 | Mr. (None) | Single Note inline form, by Rafael Somarriba |
| 5 | Mary Sue Smith | Compound last_name |
| 6 | Amy | NULL last_name (Phase 6A nullability) |
| 7 | Lead Six | Note by "Nicole Cornish" — unresolvable, becomes imported_by_name |
| 8 | Orphan (no firstName, no email) | Hard-fail — should be skipped |
| 9 | Pending Status | D365 status `Pending` not in the map → warning + default to `new` |

### Run

```sh
pnpm dlx tsx scripts/import-smoke-build.ts
pnpm dlx tsx scripts/import-smoke-run.ts
```

### Result (captured 2026-05-07)

```
File: C:\Code\MWG_CRM\test-data\mwg-crm-leads-batch-synthetic.xlsx
Smart-detect: ON
Rows parsed: 8
OK rows: 7
Failed rows: 1
Total activities: 6
Total opportunities: 1
Subjects to set: 2
Warnings: 1

--- per-row detail ---
Row 2: OK · activities=3 opps=0 subject=yes warnings=0
Row 3: OK · activities=1 opps=1 subject=yes warnings=0
Row 4: OK · activities=1 opps=0 subject=no warnings=0
Row 5: OK · activities=0 opps=0 subject=no warnings=0
Row 6: OK · activities=0 opps=0 subject=no warnings=0
Row 7: OK · activities=1 opps=0 subject=no warnings=0
Row 8: FAILED · firstName: Expected string, received null
       Row has neither First Name nor Email — cannot identify the lead.
Row 9: OK · activities=0 opps=0 subject=no warnings=1
```

Every fixture behaved exactly as designed:
- Bettina parsed 1 meeting + 2 calls; meeting had attendees and the
  duplicate "Tanzania Griffith" was deduped.
- John Costanzo's row produced 1 call and 1 opportunity with name
  "Snarky", stage `prospecting` (mapped from "In Progress"),
  probability 10, owner "Tanzania Griffith".
- Mr. (None) parsed the inline note correctly: byName="Rafael
  Somarriba", body="initial inbound about group dental".
- Amy imported with NULL last_name without errors.
- Lead Six's "Nicole Cornish" had no matching CRM user — caller will
  store as `imported_by_name`. (This shows up as a warning in the
  preview's by-names group when the full `buildImportPreview` runs;
  the smoke script only invokes `parseImportRow` so the by-name
  warning surfaces at preview-build time.)
- Orphan row hard-failed with both Zod and the explicit
  "neither First Name nor Email" check.
- Pending status produced a warning and defaulted to `new`.

## 2. Production-file smoke (manual)

When the real `mwg-crm-leads-batch-0447.xlsx` is placed at
`./test-data/mwg-crm-leads-batch-0447.xlsx`:

### Parse-only check (no DB writes)

```sh
pnpm dlx tsx scripts/import-smoke-run.ts ./test-data/mwg-crm-leads-batch-0447.xlsx
```

Expected counts (per the brief, with tolerance for parsing edge cases):
- Total rows: 113
- New leads: 113
- Subjects set: ~38
- Phone call activities: ~50
- Note activities: ~1
- Meeting activities: ~1
- Opportunities: ~3

### Full pipeline (via the deployed app)

1. Sign in to https://mwg-crm.vercel.app.
2. Navigate to `/leads/import`.
3. Click "Download template (.xlsx)" once to confirm the new template
   downloads and contains all 39 columns.
4. Choose `mwg-crm-leads-batch-0447.xlsx`.
5. Tick the **"Detect and parse legacy D365 Description column"** box.
6. Click "Preview import."
7. Verify the preview matches the expected counts above (within
   tolerance). Expand the warnings panel:
   - "Activity owner X not found in CRM" rows for any of:
     Tanzania Griffith, Nicole Cornish, etc., depending on which CRM
     accounts exist at smoke time.
   - Owner email warnings for any unmatched owner emails.
8. Click "Commit import."
9. After completion, spot-check these leads in the UI:
   - **Bettina Overbeck** — should have 1 meeting + 2 phone calls;
     `last_activity_at` = 2024-12-18 ~20:50 UTC.
   - **John Costanzo** — should have 1 phone call + 1 opportunity
     "Snarky" (stage prospecting, probability 10, owner
     Tanzania Griffith if she's a CRM user, else `imported_by_name`).
   - **Mr. (None)** — should have 1 note from 2020-04-21 by
     Rafael Somarriba.
   - **Mary Sue Smith** — should render correctly with the compound
     last name.
   - **Amy** (no last name) — should import cleanly with NULL
     `last_name`; the leads list shows "—" in the Last Name column.
10. **Re-import the same file** (smart-detect ON again):
    - Existing leads matched by external_id should appear in the
      preview as "Existing leads to update" instead of "New leads."
      Activities should NOT duplicate (the
      `activities_import_dedup_idx` partial index ensures dedup).
    - Commit and confirm "Activities skipped (dedup)" is non-zero
      and roughly equal to the number of activities created on the
      first pass.

### What to capture in this file

After running the production smoke, append a section here:

```markdown
## 3. Production-file smoke result — <date>

- Deployment ID: <Vercel deployment id>
- File: mwg-crm-leads-batch-0447.xlsx
- Preview counts: <paste from the preview screen>
- Commit result: <paste from the result screen>
- Spot checks: <pass/fail for each of the 5 leads>
- Re-import dedup: <activities skipped count>
```

## Acceptance

- [x] Synthetic smoke passes — proves every code path with fixtures.
- [ ] Production smoke run against `batch-0447.xlsx` once available.
- [ ] Re-import idempotency confirmed against the real file.
- [ ] PHASE6-IMPORT-TEST.md updated with the production-run result.
