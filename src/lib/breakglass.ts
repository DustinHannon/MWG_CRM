import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { hashPassword } from "@/lib/password";

/**
 * Breakglass account bootstrap.
 *
 * Behaviour:
 * 1. Generate a fresh 32-char random password.
 * 2. Insert the breakglass user with `INSERT … WHERE NOT EXISTS … RETURNING id`.
 *    The unique partial index `users_one_breakglass` (is_breakglass=true)
 *    guarantees at most one row even under concurrent cold starts.
 * 3. If RETURNING produced a row → we just inserted, so log the password
 *    (this is the ONE place the user ever sees it). Otherwise no-op.
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
      canViewAllLeads: true,
      canCreateLeads: true,
      canEditLeads: true,
      canDeleteLeads: true,
      canImport: true,
      canExport: true,
      canSendEmail: true,
      canViewReports: true,
    });

    // Phase 2D: every user (incl. breakglass) gets a preferences row.
    await tx
      .insert(userPreferences)
      .values({ userId: id })
      .onConflictDoNothing({ target: userPreferences.userId });

    insertedId = id;
  });

  const inserted = insertedId !== null;

  if (inserted) {
    // ONE-TIME LOG. After this Lambda restarts and finds the row, no further log.
    // Vercel runtime captures stdout; retrieve via mcp__vercel__get_runtime_logs.
    const banner = "=".repeat(60);
    console.warn(
      `\n${banner}\nBREAKGLASS ACCOUNT INITIALIZED — STORE THIS NOW\nUsername: ${BREAKGLASS_USERNAME}\nPassword: ${plaintext}\nSave this in your password manager. It will not be shown again.\nRotate via: Admin → Users → breakglass → Rotate password\n${banner}\n`,
    );
  }

  alreadyEnsured = true;
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
