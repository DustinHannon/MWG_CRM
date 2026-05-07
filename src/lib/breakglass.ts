import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
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

  // Cheap check first — most cold starts will hit this.
  const existing = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM users WHERE is_breakglass = true) AS exists
  `);
  if (existing[0]?.exists) {
    alreadyEnsured = true;
    return;
  }

  // Need to seed. Generate password, hash it, insert.
  const plaintext = generatePassword();
  const passwordHash = await hashPassword(plaintext);

  // Use a transaction so the user + permissions row are atomic.
  let inserted = false;
  await db.transaction(async (tx) => {
    const result = await tx
      .insert(users)
      .values({
        username: BREAKGLASS_USERNAME,
        email: BREAKGLASS_EMAIL,
        firstName: "Break",
        lastName: "Glass",
        displayName: "Breakglass Admin",
        isBreakglass: true,
        isAdmin: true,
        isActive: true,
        passwordHash,
      })
      .onConflictDoNothing({ target: users.isBreakglass })
      .returning({ id: users.id });

    if (result.length === 0) {
      // Lost race — another Lambda inserted first. That's fine.
      return;
    }

    await tx.insert(permissions).values({
      userId: result[0].id,
      canViewAllLeads: true,
      canCreateLeads: true,
      canEditLeads: true,
      canDeleteLeads: true,
      canImport: true,
      canExport: true,
      canSendEmail: true,
      canViewReports: true,
    });

    inserted = true;
  });

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
