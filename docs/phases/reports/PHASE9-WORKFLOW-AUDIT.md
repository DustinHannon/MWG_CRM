# PHASE 9A — CRM Workflow Audit

**Date:** 2026-05-07 · **Auditor:** Phase 9 lead agent · **Mode:** read-only.

Scope: walk the D365-style flow (Lead → Qualify → Account+Contact+Opportunity → Close Won) and verify direct-entry paths exist and feel cohesive.

Source of truth: code reading at master `1e704f3` (post-Phase 8). Every finding cites file paths so Sub-agent B in §6.2 can act directly.

---

## 1. Lead → Qualify path

**Status:** ✅ works

Files:
- `src/app/(app)/leads/[id]/page.tsx:124–137` — "Convert" button rendered when `canEdit && status !== 'converted'`.
- `src/app/(app)/leads/[id]/convert/_components/convert-modal.tsx` — modal with two checkboxes (Contact / Opportunity).
- `src/lib/conversion.ts:60–185` — single transaction: insert account → optional contact → optional opportunity → mark lead converted → reassign activities.

Behaviour:
- Account is required (`accountName.trim()` enforced client-side; server schema requires `existingAccountId` OR `newAccount`).
- Contact + Opportunity each toggleable. Both default to `true`.
- After convert: `lead.status='converted'`, `convertedAt=now()`. Activities reassign to opportunity if one was created.

**⚠️ Gaps in conversion UX (non-blocking but noted):**
- Convert button text is just "Convert" (no qualifier). The brief asks for visually prominent. It IS the leftmost button group already, with `bg-primary` (filled), so good.
- Modal copy doesn't say *"This will convert {lead name} into an Account, Contact, and Opportunity. The lead will be marked as qualified and removed from the active leads view."* — current copy is generic.
- No "use existing Account" path in the modal — only newAccount flow is exposed in the UI (`existingAccountId` is in the schema but not in the modal). Brief asks the modal to support both.

## 2. Direct Account creation

**Status:** ❌ missing

- `/accounts` page: NO "New Account" button.
- Empty state copy: *"No accounts yet. Convert a lead to create the first one."* — actively misleading.
- File: `src/app/(app)/accounts/page.tsx:20–42`.
- Schema supports it; `crmAccounts` insert is unrestricted.

## 3. Direct Contact creation

**Status:** ❌ missing

- `/contacts` page: NO "New Contact" button.
- Empty state: *"No contacts yet."* — neutral but no path forward.
- File: `src/app/(app)/contacts/page.tsx`.
- Account detail's Contacts tab also has no "New Contact" affordance.
- File: `src/app/(app)/accounts/[id]/page.tsx:104–123` — listing only.

## 4. Direct Opportunity creation on existing Account

**Status:** ❌ missing

- Account detail's Opportunities tab lists rows but has no "New Opportunity" button.
- File: `src/app/(app)/accounts/[id]/page.tsx:125–145`.

## 5. Direct Opportunity creation without Lead/Account

**Status:** ❌ missing

- `/opportunities` page: NO "New Opportunity" button.
- Empty state: *"No opportunities yet. Convert a lead to create one."* — same problem as accounts.
- File: `src/app/(app)/opportunities/page.tsx:38–75`.

## 6. Default-view behaviour vs converted leads

**Status:** ⚠️ partial

`src/lib/views.ts:53–110` — built-in views:

| View id | Filter | Includes converted? |
|---|---|---|
| `builtin:my-open` | `status: ["new","contacted","qualified"]` | ❌ no — correct |
| `builtin:all-mine` | `{}` | ✅ YES — gap |
| `builtin:all` | `{}` | ✅ YES — gap |
| `builtin:recent` | `updatedSinceDays:30` | ✅ YES — gap |
| `builtin:hot` | `rating:["hot"]` | ✅ YES — gap (the comment says "status NOT IN ('converted','lost','unqualified')" but **the filter does not implement it**) |
| `builtin:imported` | `createdSinceDays:7` | ✅ YES — borderline; an imported lead that was already converted shouldn't show here either |

**Brief's intent:** converted leads should not show in default views. Findable via "All including converted" or by manually changing the status filter.

**Recommendation for Sub-agent B:** add `notIn(["converted"])` semantics for status to `all-mine`, `all`, `recent`, `hot`, `imported`. Add a separate built-in `builtin:all-incl-converted` (admin/all-records only) for the explicit case.

## 7. Account detail tabs

**Status:** ⚠️ partial — tab structure absent

- `src/app/(app)/accounts/[id]/page.tsx` renders TWO grid cards: Contacts list + Opportunities list. No Activities tab, no Tasks tab, no Files tab.
- Brief expectation: at minimum Overview, Contacts, Opportunities, Activities, Tasks, Files.
- Activities/Tasks/Files surfacing on account is not currently scoped here per Phase 9 (no new features), but **the missing direct-entry buttons on the existing two cards are in scope** (§3 + §4 above).

## 8. Opportunity detail tabs

**Status:** ⚠️ partial — single details card

- `src/app/(app)/opportunities/[id]/page.tsx` — one GlassCard with the field grid, source-lead link. No Activities/Tasks/Files surface.
- Brief expectation similar to accounts. **Out of scope for Phase 9 fixes** (would be a feature add). Activity/task surfaces remain on lead-style detail pages.
- Sub-agent B can add a "Log Activity" pre-fill button if the activity composer is generalisable. Defer if it requires schema work.

## 9. "Closing Won" flow

**Status:** ⚠️ partial

- `src/lib/leads.ts` and opportunities path: stage transition to `closed_won` updates `closed_at` (verified via schema reading).
- Audit log: `opportunity.close_won` — needs verification in code; `audit.ts` is generic.
- ❌ No "Customer since {date}" indicator on Account detail.
- ❌ No closed-won count column on Accounts list.

## 10. Closed leads visibility

`src/app/(app)/leads/archived/page.tsx` exists for **archived (soft-deleted)** leads. **Converted** leads are a different concept and currently surface only via the All views (which include them). Brief does not require a separate "Converted" view; just: default views exclude converted, finding-by-status still works.

---

# Sub-agent B task list (driven by this audit)

Priority order:

1. **Default views: exclude converted from `all-mine`, `all`, `recent`, `imported`** — add the implicit `status NOT IN ('converted')` shape to the filter pipeline. Keep `my-open` as-is (already explicit).
2. **`hot` view** — implement the documented `status NOT IN ('converted','lost','unqualified')` (currently intent-only).
3. **`/accounts` — "New Account" button + form** (`/accounts/new`). Server action `createAccount` (Zod-validated, OCC-aware, withErrorBoundary).
4. **`/contacts` — "New Contact" button + form** (`/contacts/new`) with optional Account picker.
5. **`/opportunities` — "New Opportunity" button + form** (`/opportunities/new`). Required Account picker (autocomplete). Optional Primary Contact picker.
6. **Account detail — "New Opportunity" affordance** (header or Opportunities tab) pre-filling `account_id`.
7. **Account detail — "New Contact" affordance** on Contacts tab pre-filling `account_id`.
8. **Account detail — "Customer since {date}"** derived from `min(closed_at) WHERE stage='closed_won'`. No schema change.
9. **`/accounts` list — "Won deals" count column** (`count(opps WHERE stage='closed_won')`).
10. **Lead conversion modal copy** — replace generic intro with: "This will convert {lead name} into an Account, Contact, and Opportunity. The lead will be marked as qualified and removed from the active leads view."
11. **(Optional)** Convert modal — add a "Use existing Account" picker so the schema's `existingAccountId` path is reachable from UI.

Empty-state copy needs flipping on `/accounts`, `/contacts`, `/opportunities` once the New buttons land.

Forbidden zones for Sub-agent B (carry-over from §6.2): no schema migrations, no touching `src/components/user-display/**` or `src/components/app-shell/**`, no touching Sub-agents A/C/D scopes.
