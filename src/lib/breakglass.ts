import "server-only";
import { logger } from "@/lib/logger";
import { eq, sql, getTableColumns } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { hashPassword } from "@/lib/password";
import { writeSystemAudit } from "@/lib/audit";
import { AUDIT_EVENTS, AUDIT_SYSTEM_ACTORS } from "@/lib/audit/events";

/**
 * Breakglass account bootstrap.
 *
 * Behaviour:
 * 1. Generate a fresh 32-char random password.
 * 2. Insert the breakglass user with `INSERT … WHERE NOT EXISTS … RETURNING id`.
 * The unique partial index `users_one_breakglass` (is_breakglass=true)
 * guarantees at most one row even under concurrent cold starts.
 * 3. If RETURNING produced a row → we just inserted, so log the password
 * (this is the ONE place the user ever sees it). Otherwise no-op.
 *
 * Memoised per-process: after a successful "already exists" check, we don't
 * hit the DB again for the lifetime of this Lambda instance.
 *
 * IMPORTANT: do not await this from middleware (Edge runtime); call it from
 * server components / server actions where the Node runtime is available.
 */
let alreadyEnsured = false;

const BREAKGLASS_USERNAME = "breakglass";
const BREAKGLASS_EMAIL = "breakglass@local.mwg-crm";

export async function ensureBreakglass(): Promise<void> {
  if (alreadyEnsured) return;

  // Cheap "does it exist?" probe via the query builder. Avoids any
  // edge-case around `EXISTS(...) AS exists` column aliasing across
  // postgres-js / drizzle versions.
  const probe = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBreakglass, true))
    .limit(1);
  if (probe.length > 0) {
    // The breakglass account is the emergency super-admin; its stored
    // permission row must always grant every permission, including any
    // added to the schema after the account was first created.
    // ensureBreakglass is otherwise insert-only, so reconcile the
    // existing row here (idempotent; audits only when it changes).
    await reconcileBreakglassPermissions(probe[0].id);
    alreadyEnsured = true;
    return;
  }

  // Need to seed. Generate password, hash it, insert.
  const plaintext = generatePassword();
  const passwordHash = await hashPassword(plaintext);

  // We can't use Drizzle's `.onConflictDoNothing({ target: users.isBreakglass })`
  // because that translates to ON CONFLICT (is_breakglass) which requires a
  // FULL (non-partial) unique index on is_breakglass — and we only have the
  // partial index `users_one_breakglass` (is_breakglass=true). Instead, the
  // INSERT … SELECT … WHERE NOT EXISTS pattern is race-safe under serializable
  // and reads the partial index correctly.
  let insertedId: string | null = null;
  await db.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (
        username, email, first_name, last_name, display_name,
        is_breakglass, is_admin, is_active, password_hash
      )
      SELECT ${BREAKGLASS_USERNAME}, ${BREAKGLASS_EMAIL}, 'Break', 'Glass',
             'Breakglass Admin', true, true, true, ${passwordHash}
      WHERE NOT EXISTS (
        SELECT 1 FROM users WHERE is_breakglass = true
      )
      RETURNING id
    `);

    const id = inserted[0]?.id;
    if (!id) {
      // Lost the race — another Lambda just inserted. No-op.
      return;
    }

    await tx.insert(permissions).values({
      userId: id,
      ...allPermissionsTrue(),
    } as typeof permissions.$inferInsert);

    // every user (incl. breakglass) gets a preferences row. New
    // accounts default to dark theme.
    await tx
      .insert(userPreferences)
      .values({ userId: id, theme: "dark" })
      .onConflictDoNothing({ target: userPreferences.userId });

    insertedId = id;
  });

  const bootstrappedId: string | null = insertedId;

  if (bootstrappedId !== null) {
    // Forensic record of the emergency-access account bootstrap. System
    // actor (no user yet exists). Best-effort: writeSystemAudit swallows
    // its own failures and never throws, so it cannot break the seed.
    await writeSystemAudit({
      actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.BOOTSTRAP,
      action: AUDIT_EVENTS.USER_CREATE_BREAKGLASS,
      targetType: "user",
      targetId: bootstrappedId,
      after: { username: BREAKGLASS_USERNAME, isAdmin: true, isBreakglass: true },
    });

    // ONE-TIME LOG. After this Lambda restarts and finds the row, no further log.
    // Vercel runtime captures stdout; retrieve via mcp__vercel__get_runtime_logs.
    // Intentional plaintext print — single-shot bootstrap event captured via
    // `vercel logs`. The logger redacts known credential keys, so route this
    // through stderr directly with a marker the operator can grep.
    const banner = "=".repeat(60);
    process.stderr.write(
      `\n${banner}\nBREAKGLASS ACCOUNT INITIALIZED — STORE THIS NOW\nUsername: ${BREAKGLASS_USERNAME}\nPassword: ${plaintext}\nSave this in your password manager. It will not be shown again.\nRotate via: Admin → Users → breakglass → Rotate password\n${banner}\n`,
    );
  }

  alreadyEnsured = true;
}

/**
 * Every boolean permission column on the `permissions` table → `true`.
 *
 * Built from the Drizzle schema (`getTableColumns`) so that a permission
 * column added to the schema later is granted automatically with no edit
 * here — the breakglass account is the emergency super-admin and must
 * hold every permission, current and future. The `userId` PK is uuid
 * (not boolean) so the `dataType` guard excludes it; the explicit
 * `userId` skip is belt-and-suspenders.
 *
 * Assumption: every boolean column on `permissions` is a grant the
 * breakglass account should hold. That holds today (all 40 are `can*`
 * flags). If a non-grant boolean is ever added to that table, switch
 * this to an explicit allowlist rather than "all booleans".
 *
 * Invariant guard: if the Drizzle `getTableColumns`/`dataType` contract
 * ever changes (e.g. a major-version bump) and this resolves to far
 * fewer columns than the schema has, we must NOT silently seed/leave an
 * under-privileged emergency account — fail loudly instead. A bare
 * throw is correct here per the error policy: this is a true
 * build/contract invariant, not an app-domain failure.
 */
function allPermissionsTrue(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, col] of Object.entries(getTableColumns(permissions))) {
    if (key === "userId") continue;
    if (col.dataType !== "boolean") continue;
    out[key] = true;
  }
  if (Object.keys(out).length < 20) {
    throw new Error(
      `breakglass invariant violated: allPermissionsTrue() resolved only ` +
        `${Object.keys(out).length} permission columns from the schema ` +
        `(expected ~40). The Drizzle getTableColumns/dataType contract ` +
        `changed — refusing to seed/reconcile an under-privileged ` +
        `breakglass account.`,
    );
  }
  return out;
}

/**
 * Ensure the existing breakglass account's permission row grants every
 * permission. `ensureBreakglass` is insert-only and memoised, so a
 * permission column added after the account was created would otherwise
 * stay `false` on it forever. Runs at most once per process (gated by
 * the `alreadyEnsured` memo in the caller).
 *
 * Idempotent: no write and no audit when the row is already all-true.
 * Best-effort: the emergency sign-in path must never fail because a
 * reconcile errored — breakglass also has `isAdmin = true`, which
 * bypasses every gate regardless of these columns — so failures are
 * logged and swallowed, not rethrown.
 */
async function reconcileBreakglassPermissions(
  userId: string,
): Promise<void> {
  try {
    const desired = allPermissionsTrue();
    const keys = Object.keys(desired);

    const existing = await db
      .select()
      .from(permissions)
      .where(eq(permissions.userId, userId))
      .limit(1);

    if (!existing[0]) {
      // Defensive: breakglass user with no permissions row at all.
      await db
        .insert(permissions)
        .values({ userId, ...desired } as typeof permissions.$inferInsert);
      await writeSystemAudit({
        actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.BOOTSTRAP,
        action: AUDIT_EVENTS.USER_BREAKGLASS_PERMISSIONS_SYNC,
        targetType: "user",
        targetId: userId,
        before: null,
        after: desired,
      });
      return;
    }

    const row = existing[0] as Record<string, unknown>;
    const flipped = keys.filter((k) => row[k] !== true);
    if (flipped.length === 0) return; // already all-true — no-op

    await db
      .update(permissions)
      .set(desired as Partial<typeof permissions.$inferInsert>)
      .where(eq(permissions.userId, userId));

    await writeSystemAudit({
      actorEmailSnapshot: AUDIT_SYSTEM_ACTORS.BOOTSTRAP,
      action: AUDIT_EVENTS.USER_BREAKGLASS_PERMISSIONS_SYNC,
      targetType: "user",
      targetId: userId,
      before: Object.fromEntries(flipped.map((k) => [k, row[k] ?? false])),
      after: Object.fromEntries(flipped.map((k) => [k, true])),
    });
  } catch (err) {
    // This try guards the reconcile's DB I/O (select/insert/update) so a
    // failure can't break the emergency sign-in path — NOT the audit.
    // `writeSystemAudit` already swallows its own write failures and
    // never throws (see lib/audit.ts), so it is independently
    // best-effort and this catch never actually catches an audit error;
    // there is no try/catch *around the audit* in the §12 sense.
    logger.error("breakglass.permissions_reconcile_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 32-char base64url password. Strong enough that brute-force is not the
 * threat model (the auth path argon2-verifies on every attempt, and we have
 * no rate-limit story in v1 — see PLAN.md risk register).
 */
function generatePassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
