# Phase 6 — Import overhaul + OCC backend wiring

> Foundation work, not features. Two threads:
> 1. **OCC backend wiring (6B)** — `concurrentUpdate` exists since 4A but no update server action calls it. Real users + real data ⇒ fix now.
> 2. **Import schema overhaul (6A, 6C–6I)** — current import can't represent D365 export shape: phone call logs, notes, meetings, opportunities, and the "Topic" subject line are crammed into one `Description` column.

Push directly to `master` after each chunk. No PRs. Verify Vercel deploy green before continuing.

---

## State of play (verified before planning)

- `concurrentUpdate(args: { table, id, expectedVersion, patch, ... })` exists at `src/lib/db/concurrent-update.ts`. Throws `ConflictError` on version mismatch and `NotFoundError` on missing row.
- `version int NOT NULL DEFAULT 1` already on: `leads`, `crm_accounts`, `contacts`, `opportunities`, `tasks`, `saved_views`, `user_preferences`.
- `db.update()` calls in production code (no version checks):
  - `src/lib/leads.ts:361` — `updateLead()` used by `updateLeadAction`
  - `src/lib/tasks.ts:175` — `updateTask()` used by `updateTaskAction`
  - `src/lib/views.ts:237` — `updateSavedView()` used by `updateViewAction`
  - `src/lib/notifications.ts:86,95` — notification mark-read (low-risk; not in §3.1)
  - `src/lib/conversion.ts:160,174` — conversion path (one-shot; OCC not strictly required but worth a look)
  - `src/app/admin/data/actions.ts:79` — admin reset (not user-edit; skip)
- `leads.linkedinUrl` already exists in Drizzle schema; verify the column is in the DB and only add the CHECK constraint.
- `leads.externalId` already exists; verify and add the partial unique index if missing.
- `mwg-crm-leads-batch-0447.xlsx` is **not** in the repo workspace. We'll need it placed at `C:\Code\MWG_CRM\test-data\` or similar before §8 — flag this to the user during 6H if not present.

---

## Build order

1. **6A** Schema migrations (six, via Supabase MCP).
2. **6B** OCC backend wiring — patch every update action listed below.
3. **6C** Multi-line activity parser (standalone module + tests).
4. **6D** D365 smart-detect parser (built on 6C).
5. **6E** New 39-column ingestion pipeline.
6. **6F** Pre-flight preview UI.
7. **6G** Downloadable .xlsx template.
8. **6H** Test run against `mwg-crm-leads-batch-0447.xlsx`.
9. **6I** Documentation: `/admin/import-help`, ARCHITECTURE.md, README.md, ROADMAP.md.

After each chunk: `pnpm tsc --noEmit && pnpm lint && pnpm build` clean → push → verify Vercel.

---

## 6A — Schema migrations

Apply via Supabase MCP `apply_migration` in this order. Run `get_advisors` (security + performance) after each. Address HIGH findings before continuing.

### 6A.1 `phase6_last_name_nullable`

```sql
ALTER TABLE leads ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_last_name_len;
ALTER TABLE leads ADD CONSTRAINT leads_last_name_len
  CHECK (last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 100);

ALTER TABLE contacts ALTER COLUMN last_name DROP NOT NULL;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_last_len;
ALTER TABLE contacts ADD CONSTRAINT contacts_last_len
  CHECK (last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 100);
```

Drizzle: drop `.notNull()` on `leads.lastName` and `contacts.lastName`.

Helper added at `src/lib/format/person-name.ts`:
```ts
export function formatPersonName(p: { firstName?: string | null; lastName?: string | null }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || "(Unnamed)";
}
```

Audit and switch every render site: lead cards, lead detail header, leads table, opportunity primary contact, kanban cards, command palette results, mention picker, audit log target labels.

### 6A.2 `phase6_lead_subject`

```sql
ALTER TABLE leads ADD COLUMN subject text;
ALTER TABLE leads ADD CONSTRAINT leads_subject_len
  CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 1000);
CREATE INDEX leads_subject_trgm_idx ON leads USING GIN (subject gin_trgm_ops)
  WHERE is_deleted = false AND subject IS NOT NULL;
```

UI:
- Lead detail header — italic subject line under the name. Inline edit.
- Leads table — Subject as optional column (default off in column chooser).
- Cmd+K — picked up automatically by §6A.6 FTS index.

### 6A.3 `phase6_lead_linkedin_url_check`

Column exists per Drizzle schema. Verify and add CHECK only:

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_url text;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_linkedin_url_protocol;
ALTER TABLE leads ADD CONSTRAINT leads_linkedin_url_protocol
  CHECK (linkedin_url IS NULL OR linkedin_url ~* '^https?://');
```

Mirror on `contacts` only if the import surface needs it (§4 column mapping doesn't list it for contacts — skip unless a later mapping changes).

### 6A.4 `phase6_activity_imported_by`

```sql
ALTER TABLE activities ADD COLUMN imported_by_name text;
ALTER TABLE activities ADD CONSTRAINT activities_imported_by_name_len
  CHECK (imported_by_name IS NULL OR char_length(imported_by_name) BETWEEN 1 AND 200);
```

Drizzle: add `importedByName: text("imported_by_name")` to `activities` schema.

UI: when rendered, append a small italic "(imported)" hint after the name. When `created_by_id` is set and `imported_by_name` is NULL, render the user name as before.

### 6A.5 `phase6_activity_dedup`

```sql
ALTER TABLE activities ADD COLUMN import_dedup_key text;
CREATE INDEX activities_import_dedup_idx ON activities(lead_id, import_dedup_key)
  WHERE import_dedup_key IS NOT NULL;
```

Dedup key = `sha256(lead_id || ":" || kind || ":" || occurred_at_iso || ":" || body_first_200_chars)`. Compute in `src/lib/import/dedup-key.ts`. On import, before insert: `SELECT 1 FROM activities WHERE lead_id = $1 AND import_dedup_key = $2`. Skip insert if found.

Manually-created activities have NULL `import_dedup_key` — never deduped against imports.

### 6A.6 `phase6_fts_subject`

```sql
DROP INDEX IF EXISTS leads_fts_idx;
CREATE INDEX leads_fts_idx ON leads USING GIN (
  to_tsvector('english',
    coalesce(first_name,'') || ' ' ||
    coalesce(last_name,'')  || ' ' ||
    coalesce(company_name,'')|| ' ' ||
    coalesce(email,'')      || ' ' ||
    coalesce(phone,'')      || ' ' ||
    coalesce(subject,'')
  )
) WHERE is_deleted = false;
```

(Note: schema column is `company_name`, not `company` — brief had a small inaccuracy.)

### 6A.7 `phase6_external_id_unique`

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_id text;
DROP INDEX IF EXISTS leads_external_id_unique;
CREATE UNIQUE INDEX leads_external_id_unique
  ON leads(external_id)
  WHERE external_id IS NOT NULL AND is_deleted = false;
```

Verify `leads_external_id_idx` (non-unique, from Phase 1) still exists; both indexes can coexist for query patterns.

---

## 6B — OCC backend wiring

The `concurrentUpdate` helper takes `{ table, id, expectedVersion, patch, entityLabel }`. Call sites must pass `expectedVersion` and forward the `version: number` field through the action input.

### 6B.1 Server actions to patch

| Action | File | Underlying lib |
|---|---|---|
| `updateLeadAction` | `src/app/(app)/leads/actions.ts` | `src/lib/leads.ts:updateLead` |
| `updateOpportunityAction` | `src/app/(app)/opportunities/[id]/...` (find) | (find) |
| `updateAccountAction` | `src/app/(app)/accounts/[id]/...` (find) | (find) |
| `updateContactAction` | `src/app/(app)/contacts/[id]/...` (find) | (find) |
| `updateTaskAction` | `src/app/(app)/tasks/actions.ts` | `src/lib/tasks.ts:updateTask` |
| `updateViewAction` (saved view) | `src/app/(app)/leads/view-actions.ts` | `src/lib/views.ts:updateSavedView` |
| `updatePreferencesAction` | `src/app/(app)/settings/actions.ts` | (inline) |

For each:
1. Add `version: z.coerce.number().int().positive()` to the input schema.
2. Replace direct `db.update()` with `concurrentUpdate({ table, id, expectedVersion: version, patch, entityLabel })`.
3. Return the new row (with bumped `version`) so the form can keep it for the next save.
4. Let `ConflictError` propagate through `withErrorBoundary` (or the existing try/catch pattern in actions). The thrown message is already user-facing.

### 6B.2 Edit-form changes

Each form must:
1. Read `version` from the loaded record.
2. Carry it through state (FormData hidden input or `useState`).
3. Pass it on submit.
4. After a successful save, store the new `version` from the action's returned row.

Pattern for a FormData-style action:
```tsx
<input type="hidden" name="version" value={lead.version} />
```

For client components using `startTransition` + state, store the latest version in form state and update it from the action result.

### 6B.3 Conflict UX

`ConflictError.publicMessage` reaches the action result. Surface as toast with `duration: Infinity, dismissible: true`. No banner, no "view their changes" UI — that's still 5C polish, deferred. Roadmap entry stays.

### 6B.4 Two-tab smoke test

Document in `PHASE6-OCC-TEST.md`:
1. Open same lead in tab A and tab B.
2. Tab A: change Company → Save → success.
3. Tab B (still showing old Company): change Notes → Save → conflict toast.
4. Tab B: refresh, observe tab A's change, edit again → success.
5. Repeat for one other entity (task or saved view).

Acceptance: every action above calls `concurrentUpdate`; second-tab save fires conflict toast; first-save still works with no regression.

---

## 6C — Multi-line activity parser

`src/lib/import/activity-parser.ts`. Pure function: takes raw column text + `kind`, returns `ParsedActivity[]` and `ParseWarning[]`.

### 6C.1 Output shape

```ts
type ActivityKind = "call" | "meeting" | "note" | "email";

interface ParsedActivity {
  kind: ActivityKind;
  occurredAt: Date;
  subject: string | null;
  body: string;
  metadata: {
    direction?: "outgoing" | "incoming";
    outcome?: string;             // "Left Voicemail" | "No Answer" | "Connected" | etc.
    durationMin?: number;
    byName?: string;              // un-normalized name for resolution
    attendees?: string[];         // meetings only, deduped
    endAt?: Date;                 // meetings only
    status?: string;              // meetings: "Completed" | "Cancelled" | ...
    fromEmail?: string;           // emails only
    toEmail?: string;             // emails only
  };
}

interface ParseWarning {
  message: string;
  line?: number;                  // 1-based line in the input
}
```

### 6C.2 Format rules

**Header pattern (calls/meetings/emails):**
```
^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,4})\]\s*(.*)$
```
Capture timestamp + tz + subject. Parse tz with a small allowlist (`UTC`, `EST`, `EDT`, `CT`, `CST`, `CDT`, `MT`, `MST`, `MDT`, `PT`, `PST`, `PDT`); unknown tz → warning, default UTC.

**Calls metadata line (indented):**
- `Outgoing | Duration: 30 min | By: Tanzania Griffith`
- `Outgoing | Left Voicemail | By: Tanzania Griffith`
- `Incoming | No Answer | By: Tanzania Griffith`
- `Outgoing | Connected | By: Tanzania Griffith`

Direction always first segment. Middle is "outcome" — try to match `Duration: N min` (extract minutes) else use the literal string. By name from `By:` segment.

**Meetings metadata line:**
- `Status: Completed | End: 2024-12-16 05:00 PM UTC | Duration: 30 min | Owner: Tanzania Griffith`
- Optional next line: `Attendees: Name1, Name2, Name3` — split on comma, trim, dedupe (case-insensitive).

**Notes format (single line w/ inline by):**
```
^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+([A-Z]{2,4})\]\s*[—-]\s*by\s+(.+?)\s+(.+)$
```
The `—` and `-` are both possible visually depending on encoding.

**Emails format (anticipated):**
```
[YYYY-MM-DD HH:MM AM/PM TZ] Subject
  From: a@x.com | To: b@y.com
  body
```

### 6C.3 Body collection

After header line: every following line that starts with whitespace OR is non-empty without matching another header is part of the activity body. Stop at next header line or EOF or blank-line-then-blank-line.

Body lines: strip a single leading `  ` (two-space indent) if present, preserve other indentation. Join with `\n`. Trim trailing whitespace.

### 6C.4 Cap at 200 activities

If parsed array > 200: sort by `occurredAt` desc, keep top 200, push warning `"Truncated to 200 most recent activities (parsed N)."`.

### 6C.5 Unit smoke

Throw a few sample inputs at the parser in a quick scratch script (no jest/vitest in the project; just a `tsx scripts/parse-smoke.ts`-style runner under `scripts/`). Cover:
- Single call with duration
- Multiple calls including voicemail (no-duration)
- Note with em-dash
- Meeting with attendees + duplicate attendee
- Email with From/To
- Truncation case (synthetic 250 calls)

Don't ship the script as a test — just paste the run results into `PHASE6-IMPORT-TEST.md`.

---

## 6D — D365 smart-detect parser

`src/lib/import/d365-detect.ts`.

### 6D.1 Detection

Returns true if the description text contains any of these literal labels (case-sensitive, line-anchored):
`Topic:`, `Phone Calls:`, `Notes:`, `Appointments:`, `Meetings:`, `Emails:`, `Linked Opportunity:`, `Description:`.

### 6D.2 Section splitter

Section header = a line whose **only content** is one of the labels above. Section ends at the next section header at the same indentation level OR EOF.

Section content is opaque to the splitter (handles nested `Description:` inside `Linked Opportunity:`).

Output:
```ts
interface DetectedSections {
  topic?: string;                    // single-line trailing text
  description?: string;              // explicit Description: section
  phoneCalls?: ParsedActivity[];
  notes?: ParsedActivity[];
  meetings?: ParsedActivity[];
  emails?: ParsedActivity[];
  opportunities?: ParsedOpportunity[];
}

interface ParsedOpportunity {
  name?: string;
  status?: string;       // raw D365 status — mapped in 6E
  probability?: number;  // 0-100
  amount?: number;
  ownerName?: string;
  description?: string;
}
```

### 6D.3 Linked Opportunity sub-parser

Section body line-by-line. Match `^(\w+):\s*(.+)$` for known fields: `Name`, `Status`, `Probability`, `Amount`, `Owner`, `Description`. Unknown fields → warning, dropped.

`Probability:` value strip trailing `%`, parse int 0-100.
`Amount:` strip currency symbols/commas, parse numeric.

Multiple `Linked Opportunity:` sections → array. Owner-name resolution failure is a warning, not an error.

### 6D.4 Stage and status mapping

`src/lib/import/stage-mapping.ts`:
```ts
export const D365_STATUS_TO_STAGE = {
  "In Progress": "prospecting",
  "Won":         "closed_won",
  "Lost":        "closed_lost",
  "On Hold":     "qualification",
  "Cancelled":   "closed_lost",
} as const;
```

`src/lib/import/status-mapping.ts`:
```ts
export const D365_STATUS_TO_LEAD_STATUS = {
  "Open":               "new",
  "Attempting Contact": "contacted",
  "Qualified":          "qualified",
  "Not Interested":     "unqualified",
  "No Response":        "unqualified",
  "Lost":               "lost",
} as const;
```

Both fall back to a default with a warning.

---

## 6E — New 39-column import structure

New column list (§4 of the brief). Ingestion pipeline in `src/lib/import/`:

- `src/lib/import/headers.ts` — canonical header → field map for the 39 columns.
- `src/lib/import/normalize.ts` — value-level normalization (phone E.164 via libphonenumber-js, URL protocol, email lowercase, etc.).
- `src/lib/import/resolve-users.ts` — batch lookup of `users.email` (lower) and `users.displayName`/`firstName + lastName` for owner emails and By-name strings.
- `src/lib/import/dedup-key.ts` — sha256 helper for `import_dedup_key`.
- `src/lib/import/parse-row.ts` — per-row Zod validation + activity-column parsing + smart-detect application.
- `src/lib/import/commit.ts` — chunked write path using `concurrentUpdate` for updates.

### 6E.1 Idempotent re-import

- If `External ID` populated AND matches an existing non-deleted lead's `external_id`: UPDATE that lead via `concurrentUpdate({ table: leads, id, expectedVersion: existing.version, patch })`. If update conflicts mid-run, retry once with re-read; if still conflicting, surface as a row-level warning and skip activities/opps (data integrity over completeness).
- If `External ID` absent: always INSERT new (no email-based fuzzy matching for re-imports).
- New activities: dedup by `(lead_id, import_dedup_key)` — skip if exists.
- New opportunities: skip if a non-deleted opp with `source_lead_id = lead.id AND name = parsed_name` already exists.

### 6E.2 Owner / By-name resolution

Owner email columns:
- `lower(value)` exact match against `users.email`.
- No match → row-level warning, `owner_id = NULL`.

By-name (from activity bodies):
- Normalize: trim, collapse internal whitespace, lowercase.
- Try: `users.displayName` (case-insensitive exact).
- Fallback: `users.firstName + ' ' + users.lastName` (case-insensitive exact).
- No match → `created_by_id = NULL`, `imported_by_name = original (pre-normalization) string`.

Batch one query for all owner emails + one query for all distinct By-names per import to avoid N+1.

### 6E.3 Tags autocreate

For each tag name in `Tags` column:
- Look up by case-insensitive name in `tags` table.
- Missing → INSERT with default color (slate).
- Insert `(lead_id, tag_id)` into `lead_tags`.

### 6E.4 last_activity_at

After inserting parsed activities, recompute `leads.last_activity_at` from `MAX(activities.occurred_at)` where `kind` is in the Phase 5B counting set (calls, meetings, notes, emails — NOT tasks). If the import provided a `Last Activity Date` column, prefer it as a manual override only when it's later than the computed max; else use computed.

---

## 6F — Pre-flight preview

`/leads/import` becomes three steps. Existing route stays; add a preview state.

### 6F.1 Server-side preview

Single server action `previewImportAction(formData)`:
1. Stream-parse workbook (exceljs streaming API, cap 10k rows from Phase 4A still applies).
2. For each row: Zod validate, run activity parser (6C), run smart-detect if enabled (6D).
3. Batch-resolve owner emails + By-names.
4. Batch-lookup existing leads by `external_id`.
5. Aggregate into preview shape: counts, warnings list, errors list, full per-row plan (kept server-side and stashed by id; client gets aggregate).

Cache the full plan keyed by a short token returned to client. Cache TTL 15 min. Use Vercel Runtime Cache (per Vercel skill); fallback to in-process map for local.

### 6F.2 Preview UI

Section blocks: Records, Activities, Opportunities, Settings (smart-detect toggle), Warnings (expandable), Errors (expandable). [Cancel] / [Commit import].

### 6F.3 Commit

`commitImportAction(token)`:
1. Re-fetch the cached plan by token. If expired → "Preview expired, please re-upload."
2. Process in 100-row chunks per transaction.
3. Per chunk: insert/update lead (with `concurrentUpdate` for updates), insert activities (with dedup keys), insert opportunities, update lead_tags, recompute last_activity_at.
4. Catch chunk failure, log error, continue with next chunk.
5. Audit log: `import.commit` with file name, full preview snapshot, totals, warnings.
6. Result page: same shape as preview, plus actual created/updated counts and chunk failures.

---

## 6G — Downloadable .xlsx template

Server route: `GET /leads/import/template`. Generated with exceljs.

### 6G.1 Sheets

**Leads** — 39 headers + 3 example rows (minimal / typical / rich-data with multi-line activity cells using `\n`).

**Instructions** — column-by-column docs table + sections:
- Multi-line activity format with examples.
- Status / stage mapping tables.
- Smart-detect explanation + when to use.

**Allowed values** — status, rating, opportunity stage enums.

### 6G.2 Button placement

Top-right of `/leads/import`, next to file picker. Linked from `/admin/import-help`.

---

## 6H — Smoke test against batch-0447 file

**Prerequisite:** `mwg-crm-leads-batch-0447.xlsx` is not in the workspace. Need to be placed at a known path (e.g., `C:\Code\MWG_CRM\test-data\`) before running. If absent at this step → ask the user.

### 6H.1 Procedure

1. Smart-detect ON.
2. Upload → preview.
3. Verify counts within tolerance:
   - Total rows: 113
   - New leads: 113
   - Subjects set: ~38
   - Phone call activities: ~50
   - Note activities: ~1
   - Meeting activities: ~1
   - Opportunities: ~3
4. Commit.
5. Spot-check leads:
   - **Bettina Overbeck** — 1 meeting + 2 calls; `last_activity_at` = 2024-12-18 ~20:50 UTC.
   - **John Costanzo** — 1 call + 1 opportunity ("Snarky", prospecting, 10%, owner Tanzania Griffith if user exists else `imported_by_name`).
   - **Mr. (None)** — 1 note from 2020-04-21 by Rafael Somarriba.
   - **Mary Sue Smith** — last_name = "Sue Smith", renders correctly.
   - **Amy** — NULL last_name imports cleanly.
6. Re-import same file → zero duplicate activities (dedup keys), leads update via `concurrentUpdate` with no conflicts.
7. Document everything in `PHASE6-IMPORT-TEST.md`.

---

## 6I — Documentation

- **`/admin/import-help`** — admin-only static page: column docs, multi-line format, mappings, smart-detect, dedup behaviour, By-name snapshot mechanism.
- **`ARCHITECTURE.md`** — new "Import pipeline" section: preview-then-commit flow, smart-detect as legacy bridge, `import_dedup_key`, `imported_by_name`.
- **`README.md`** — short "where the import code lives" note.
- **`ROADMAP.md`** — parking lot:
  - 5C polished conflict banner UI (still deferred).
  - Admin "claim/remap imported_by_name" tool.
  - Bulk re-parse for legacy leads with D365 dump still in description.
  - Bidirectional Tags / Owner sync against authoritative HR list.

---

## Acceptance gates per chunk

After each push:
- `pnpm tsc --noEmit` clean
- `pnpm lint` clean
- `pnpm build` clean
- Vercel deploy green (`get_deployment_build_logs` for the latest)
- For migrations: `get_advisors` security + performance, no new HIGH findings

Final report (per §13 of brief): production status, schema migrations, OCC proof, parser proof, smart-detect proof, test file run, template proof, before/after capability summary, manual steps for the user, anything stuck.
