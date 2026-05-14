import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { logger } from "@/lib/logger";
import { getRequestId } from "@/lib/observability/request-context";

/**
 * Append a system-initiated audit event (no user actor).
 *
 * Used for events fired by anonymous public endpoints — webhook signature
 * failures, replay rejects, rate-limit breaches — where there is no Entra
 * user to attribute to. Mirrors the cron self-audit pattern (actor_id NULL,
 * actor_email_snapshot a sentinel like "system@webhook" / "system@cron").
 *
 * Like `writeAudit`, this is best-effort — a failure to record never
 * blocks the calling handler.
 */
export async function writeSystemAudit(args: {
  actorEmailSnapshot: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  ipAddress?: string;
}): Promise<void> {
  try {
    // auto-pick requestId from AsyncLocalStorage when
    // the caller didn't supply one explicitly, so every audit row
    // emitted during a single request shares the same correlation id.
    const requestId = args.requestId ?? getRequestId() ?? null;
    await db.insert(auditLog).values({
      actorId: null,
      actorEmailSnapshot: args.actorEmailSnapshot,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      beforeJson: args.before === undefined ? null : (args.before as object),
      afterJson: args.after === undefined ? null : (args.after as object),
      requestId,
      ipAddress: args.ipAddress ?? null,
    });
  } catch (err) {
    logger.error("audit.system_write_failed", {
      action: args.action,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Append an audit event. Best-effort — we never want a write failure to
 * block the actual mutation it's recording, so we catch and log.
 *
 * @param args.actorId User performing the action.
 * @param args.actorEmailSnapshot Optional pre-resolved email; when omitted we
 * look it up so audit rows preserve the email even after the user is deleted.
 */
export async function writeAudit(args: {
  actorId: string;
  actorEmailSnapshot?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  ipAddress?: string;
}): Promise<void> {
  try {
    let snapshot = args.actorEmailSnapshot ?? null;
    if (!snapshot && args.actorId) {
      const [u] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, args.actorId))
        .limit(1);
      snapshot = u?.email ?? null;
    }

    // auto-pick requestId from AsyncLocalStorage.
    const requestId = args.requestId ?? getRequestId() ?? null;
    await db.insert(auditLog).values({
      actorId: args.actorId,
      actorEmailSnapshot: snapshot,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      beforeJson: args.before === undefined ? null : (args.before as object),
      afterJson: args.after === undefined ? null : (args.after as object),
      requestId,
      ipAddress: args.ipAddress ?? null,
    });
  } catch (err) {
    logger.error("audit.write_failed", {
      action: args.action,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * F-Ω-5: chunk size for {@link writeAuditBatch}. Beyond this, the
 * batch is broken into independent INSERTs so a single bad row (jsonb
 * size violation, target_id length, etc.) only poisons its chunk's
 * audit rows instead of the entire batch.
 *
 * Sized to keep us well under Postgres's 65,535 bind-parameter limit
 * (9 columns × 500 rows = 4,500 params per chunk) and to keep network
 * round-trips bounded for bulk operations that hit the 5,000-record
 * BULK_SCOPE_EXPANSION_CAP (10 chunks per max bulk operation).
 */
const AUDIT_BATCH_CHUNK_SIZE = 500;

/**
 * Append a batch of audit events written by the same actor in one
 * logical operation (bulk tag apply, bulk archive, bulk reassign,
 * etc.). Chunked into single-INSERT statements of
 * {@link AUDIT_BATCH_CHUNK_SIZE} rows. Same best-effort contract as
 * {@link writeAudit}: a chunk-INSERT failure does NOT block the
 * primary mutation; it logs the chunk's failure and continues with
 * the remaining chunks so a single bad row (constraint violation,
 * jsonb size, etc.) only loses its chunk's forensic trail instead of
 * the entire batch.
 *
 * Resolves `actorEmailSnapshot` once (one extra round trip rather
 * than N) when omitted; picks up the active request id from
 * AsyncLocalStorage. Each event carries its own action / targetType
 * / targetId / before / after — the batch is a perf optimization,
 * not an aggregation: each row remains independently queryable.
 *
 * Empty `events` is a no-op.
 */
export async function writeAuditBatch(args: {
  actorId: string;
  actorEmailSnapshot?: string | null;
  events: Array<{
    action: string;
    targetType?: string;
    targetId?: string;
    before?: unknown;
    after?: unknown;
  }>;
  requestId?: string;
  ipAddress?: string;
}): Promise<void> {
  if (args.events.length === 0) return;
  let snapshot = args.actorEmailSnapshot ?? null;
  if (snapshot === null && args.actorId) {
    try {
      const [u] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, args.actorId))
        .limit(1);
      snapshot = u?.email ?? null;
    } catch (err) {
      // Snapshot lookup failure is non-fatal — we'll insert with null
      // snapshot so the forensic trail still lands.
      logger.warn("audit.batch_actor_lookup_failed", {
        actorId: args.actorId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const requestId = args.requestId ?? getRequestId() ?? null;
  const ipAddress = args.ipAddress ?? null;

  for (let i = 0; i < args.events.length; i += AUDIT_BATCH_CHUNK_SIZE) {
    const chunk = args.events.slice(i, i + AUDIT_BATCH_CHUNK_SIZE);
    const rows = chunk.map((e) => ({
      actorId: args.actorId,
      actorEmailSnapshot: snapshot,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      beforeJson: e.before === undefined ? null : (e.before as object),
      afterJson: e.after === undefined ? null : (e.after as object),
      requestId,
      ipAddress,
    }));
    try {
      await db.insert(auditLog).values(rows);
    } catch (err) {
      // Per-chunk best-effort: log this chunk's failure and continue
      // with the next. The primary mutation already committed before
      // this helper was invoked; we never block on audit emission.
      logger.error("audit.batch_write_failed", {
        actorId: args.actorId,
        sampleAction: chunk[0]?.action ?? null,
        chunkIndex: i / AUDIT_BATCH_CHUNK_SIZE,
        chunkSize: chunk.length,
        totalEvents: args.events.length,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
