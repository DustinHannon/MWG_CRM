import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { templateLocks } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { env } from "@/lib/env";

/**
 * Phase 19 — Soft-lock infrastructure for collaborative template editing.
 *
 * The lock is one row per template_id. Acquiring requires either no row
 * (or a stale one — older than MARKETING_LOCK_TIMEOUT_SECONDS) or a row
 * already held by the same user+session (idempotent re-acquire on page
 * remount). Heartbeats slide the timeout forward.
 *
 * Concurrency: the acquire path uses a `INSERT … ON CONFLICT DO UPDATE
 * WHERE …` so two simultaneous requests resolve to exactly one winner at
 * the SQL layer. We never need an explicit transaction for acquire.
 */

const TIMEOUT_SQL_INTERVAL = sql.raw(
  `'${env.MARKETING_LOCK_TIMEOUT_SECONDS} seconds'`,
);

export interface TemplateLockState {
  templateId: string;
  userId: string;
  userName: string;
  sessionId: string;
  acquiredAt: Date;
  heartbeatAt: Date;
}

export type AcquireResult =
  | { acquired: true; lock: TemplateLockState }
  | { acquired: false; lockedBy: TemplateLockState };

/**
 * Try to acquire (or refresh) the lock for `templateId`. Returns
 * `{ acquired: true }` with the new lock state, or `{ acquired: false }`
 * with information about who's currently editing.
 *
 * SQL contract: if a row exists for this template AND it's still fresh
 * (heartbeat > now() - timeout) AND it's held by a different user, the
 * UPSERT no-ops via the `WHERE` predicate and the row is unchanged. The
 * follow-up SELECT then returns whoever currently holds it.
 */
export async function acquireLock(
  templateId: string,
  userId: string,
  sessionId: string,
): Promise<AcquireResult> {
  // UPSERT — only overwrite the row if the existing lock is stale OR it's
  // already ours. Drizzle's `onConflictDoUpdate.where` clause becomes the
  // WHERE on the UPDATE half of the upsert. If none match, the existing
  // row stays put and we'll return it from the SELECT below.
  await db
    .insert(templateLocks)
    .values({ templateId, userId, sessionId })
    .onConflictDoUpdate({
      target: templateLocks.templateId,
      set: {
        userId,
        sessionId,
        acquiredAt: sql`now()`,
        heartbeatAt: sql`now()`,
      },
      where: sql`(
        ${templateLocks.heartbeatAt} < now() - ${TIMEOUT_SQL_INTERVAL}::interval
        OR (
          ${templateLocks.userId} = ${userId}
          AND ${templateLocks.sessionId} = ${sessionId}
        )
      )`,
    });

  const current = await loadLockState(templateId);
  if (!current) {
    // INSERT raced against a concurrent DELETE; rare. Treat as not acquired.
    return {
      acquired: false,
      lockedBy: {
        templateId,
        userId: "",
        userName: "another editor",
        sessionId: "",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
      },
    };
  }
  if (current.userId === userId && current.sessionId === sessionId) {
    return { acquired: true, lock: current };
  }
  return { acquired: false, lockedBy: current };
}

/**
 * Slide the heartbeat forward. Only the holder can heartbeat their own
 * lock — a stale-lock takeover by another user would expose the original
 * holder's edits being silently overwritten.
 */
export async function heartbeat(
  templateId: string,
  userId: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  const result = await db
    .update(templateLocks)
    .set({ heartbeatAt: sql`now()` })
    .where(
      and(
        eq(templateLocks.templateId, templateId),
        eq(templateLocks.userId, userId),
        eq(templateLocks.sessionId, sessionId),
      ),
    )
    .returning({ templateId: templateLocks.templateId });
  return { ok: result.length > 0 };
}

/**
 * Release the lock. Same constraint as heartbeat: only the holder can
 * release their own lock. (For admin force-unlock, see
 * `forceReleaseLock`.)
 */
export async function releaseLock(
  templateId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db
    .delete(templateLocks)
    .where(
      and(
        eq(templateLocks.templateId, templateId),
        eq(templateLocks.userId, userId),
        eq(templateLocks.sessionId, sessionId),
      ),
    );
}

/**
 * Admin-only: drop a lock regardless of holder. The audit caller should
 * write `marketing.template.lock_force_release` so the original holder
 * can be notified.
 */
export async function forceReleaseLock(templateId: string): Promise<void> {
  await db.delete(templateLocks).where(eq(templateLocks.templateId, templateId));
}

/**
 * Read the current lock state with the holder's display name attached.
 * Returns null when no lock exists or the row is stale (the next acquire
 * will reuse it).
 */
export async function getLock(
  templateId: string,
): Promise<TemplateLockState | null> {
  return loadLockState(templateId);
}

async function loadLockState(
  templateId: string,
): Promise<TemplateLockState | null> {
  const [row] = await db
    .select({
      templateId: templateLocks.templateId,
      userId: templateLocks.userId,
      sessionId: templateLocks.sessionId,
      acquiredAt: templateLocks.acquiredAt,
      heartbeatAt: templateLocks.heartbeatAt,
      userName: users.displayName,
    })
    .from(templateLocks)
    .leftJoin(users, eq(users.id, templateLocks.userId))
    .where(eq(templateLocks.templateId, templateId))
    .limit(1);
  if (!row) return null;
  // Stale rows are still "held" until pruned, but the acquire path
  // overwrites them. Return as-is so callers can show the staleness in UI.
  return {
    templateId: row.templateId,
    userId: row.userId,
    sessionId: row.sessionId,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    userName: row.userName ?? "another editor",
  };
}
