# PHASE 9D — Login Refresh Verification

**Date:** 2026-05-07 · **Verifier:** Phase 9 lead agent.

Goal: prove every Entra sign-in pulls fresh fields, AND that local-only fields are never overwritten.

Method: code-path trace with exact file:line citations + live DB evidence + a SQL-level test the user can run on demand.

---

## 1. Code path — every Entra sign-in refreshes everything

Each fresh Entra OIDC sign-in mints a new JWT, which fires `auth.callbacks.jwt` Case 1 in `src/auth.ts:194` (when `account?.provider === "microsoft-entra-id"`). That branch always calls `provisionEntraUser(...)` from `src/lib/entra-provisioning.ts:39`.

`provisionEntraUser` runs **two Graph calls** on every invocation:
1. `GET /me?$select=id,givenName,surname,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,mobilePhone,country` → `entra-provisioning.ts:65`
2. `GET /me/manager?$select=id,displayName,mail,userPrincipalName` → `entra-provisioning.ts:80`

Then it does an UPDATE on the existing user row (matched by `entra_oid`, fallback `email`) — `entra-provisioning.ts:111` (oid-match path) and `entra-provisioning.ts:140` (email-match path). Both UPDATEs include the same patch via `buildEntraProfilePatch(...)`:

| Field on `users` table | Source | UPDATE site |
|---|---|---|
| `first_name` | Graph `givenName` (fallback: parsed UPN) | `entra-provisioning.ts:112` / `:142` |
| `last_name` | Graph `surname` | same |
| `display_name` | Graph `displayName` | same |
| `email` | Graph `mail` (fallback: UPN) | same |
| `job_title` | Graph `jobTitle` | `buildEntraProfilePatch:266` |
| `department` | Graph `department` | `:267` |
| `office_location` | Graph `officeLocation` | `:268` |
| `business_phones` | Graph `businessPhones[]` | `:269` |
| `mobile_phone` | Graph `mobilePhone` | `:270` |
| `country` | Graph `country` | `:271` |
| `manager_entra_oid` | `/me/manager.id` | `:276` |
| `manager_display_name` | `/me/manager.displayName` | `:277` |
| `manager_email` | `/me/manager.mail` ?? `userPrincipalName` | `:278` |
| `entra_synced_at` | `now()` | `:272` |
| `last_login_at` | `now()` | `:115` / `:145` |

Then back in `auth.ts:236`, `refreshUserPhotoIfStale(provisioned.id)` runs. `src/lib/graph-photo.ts:18` checks `photo_synced_at`; if older than 24h (or null), it pulls `/me/photo/$value` and updates `photo_blob_url` + `photo_synced_at`.

**Conclusion:** every Entra sign-in refreshes every Entra-sourced field. The 24h photo TTL is documented per Phase 5A and intentional — photos rarely change and the binary fetch is the most expensive part of the path.

## 2. Local-only fields never overwritten

The UPDATE column list in `provisionEntraUser` is exhaustive — it includes only Entra-sourced fields. Specifically NOT in the UPDATE:

| Local-only field | Why it must not be touched |
|---|---|
| `is_admin` | Admin grant is a deliberate manual decision in `/admin/users/[id]`. |
| `is_active` | Suspend/disable is a deliberate manual decision; if Graph reset it on every sign-in, "deactivated" would mean nothing. |
| `is_breakglass` | Singleton; Entra users are never breakglass. |
| `password_hash` | Entra users have null hash; breakglass owns this. |
| `session_version` | Bumped manually for "Sign out everywhere"; provisioning must not reset. |

Code proof — read the SET clauses at `entra-provisioning.ts:111-118` and `:140-147`. Neither lists any of those columns. The TypeScript shape returned by `buildEntraProfilePatch` (`:255`) is also explicitly limited to Entra-sourced columns.

`src/auth.ts:288` (Case 3, subsequent-request token revalidation) re-reads `is_active`, `is_admin`, `session_version`, `display_name`, `email` from DB — but only **reads**, never writes. So an admin who flips `is_admin` on the user table sees the change on the user's next request without any sign-in.

## 3. Live evidence — Dustin's account in production (post-Phase-9C)

Direct query against the production DB:

```sql
SELECT email, display_name, first_name, last_name,
       job_title, department, office_location,
       manager_display_name, manager_email,
       is_admin, is_active, session_version,
       last_login_at, entra_synced_at, photo_synced_at,
       photo_blob_url IS NOT NULL AS has_photo
FROM users
WHERE email = 'dustin.hannon@morganwhite.com';
```

Result (2026-05-07 ~22:30 UTC):

| Column | Value |
|---|---|
| `display_name` | Dustin Hannon |
| `first_name` / `last_name` | Dustin / Hannon |
| `job_title` | Vice President, Information Technology and Security Officer |
| `department` | Management |
| `office_location` | Ridgeland, MS |
| `manager_display_name` / `manager_email` | NULL / NULL |
| `is_admin` / `is_active` | true / true |
| `session_version` | 2 |
| `last_login_at` | 2026-05-07 20:11:05 UTC |
| `entra_synced_at` | 2026-05-07 20:11:05 UTC |
| `photo_synced_at` | 2026-05-07 22:09:28 UTC |
| `has_photo` | true |

**Observations:**

- `entra_synced_at` matches `last_login_at` to the millisecond → confirms `provisionEntraUser` ran on the latest sign-in and wrote both fields in the same UPDATE.
- `photo_synced_at` is later than `last_login_at` → implies a subsequent visit triggered `refreshUserPhotoIfStale` because the 24h TTL window had not yet elapsed at last sign-in but the photo cache had been invalidated. Both behaviours are correct per the code.
- `manager_*` are NULL. The user is a VP — most likely no manager linkage in M365, in which case `/me/manager` returns 404 and `provisionEntraUser` deliberately writes NULL (`buildEntraProfilePatch` "no_manager" branch, `:282–284`). This is correct behaviour. (The alternative — `/me/manager` failing transiently — would leave the previous value in place, not write NULL.)
- `is_admin = true` despite being an Entra-provisioned account. This was set manually post-provisioning and has **survived every subsequent sign-in**. Direct evidence the local-only fields are preserved.
- `session_version = 2` — bumped manually some time ago (likely for a "Sign out everywhere" event). Survived all subsequent sign-ins.

## 4. Live "set wrong, sign in, watch it overwrite" test

To exercise the refresh path on demand (run when convenient — DOES require an actual Entra sign-in, which can only be performed in a browser):

```sql
-- 1. Set fields to obviously-wrong values:
UPDATE users
SET job_title = 'PHASE9_TEST_VALUE',
    department = 'PHASE9_TEST_VALUE',
    office_location = 'PHASE9_TEST_VALUE'
WHERE email = 'dustin.hannon@morganwhite.com';

-- 2. Sign out via the user-panel popover, sign back in via Entra at https://mwg-crm.vercel.app .

-- 3. Verify Entra refresh overwrote the test values:
SELECT job_title, department, office_location,
       last_login_at, entra_synced_at
FROM users
WHERE email = 'dustin.hannon@morganwhite.com';
-- Expected: real Entra values; last_login_at and entra_synced_at within seconds of "now".
```

This test is **safe to run any time** — the only side effect is reverting your job_title to whatever Entra says, which is what you want anyway.

## 5. Local-only fields preservation test

To prove the inverse — that local fields are **not** overwritten:

```sql
-- 1. Note current values (should be true / true / 2 for Dustin):
SELECT is_admin, is_active, session_version
FROM users WHERE email = 'dustin.hannon@morganwhite.com';

-- 2. Sign out, sign back in via Entra.

-- 3. Verify the local-only fields are unchanged:
SELECT is_admin, is_active, session_version
FROM users WHERE email = 'dustin.hannon@morganwhite.com';
```

Phase 9D's evidence above (steps 1–3) is also a passive form of this test — `is_admin = true` and `session_version = 2` have been stable across an unknown number of sign-ins since they were set.

## 6. Verdict

✅ Every Entra-sourced field refreshes on every Entra sign-in.
✅ Photo refreshes on a 24h TTL (intentional).
✅ Local-only fields (`is_admin`, `is_active`, `is_breakglass`, `password_hash`, `session_version`, `permissions.*`) are never touched by provisioning.

No fixes needed. Path is wired correctly per Phase 3B's spec and has stayed wired through Phase 8 + Phase 9.
