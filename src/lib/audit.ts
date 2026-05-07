import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { logger } from "@/lib/logger";

/**
 * Append an audit event. Best-effort — we never want a write failure to
 * block the actual mutation it's recording, so we catch and log.
 *
 * @param args.actorId            User performing the action.
 * @param args.actorEmailSnapshot Optional pre-resolved email; when omitted we
 *   look it up so audit rows preserve the email even after the user is deleted.
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

    await db.insert(auditLog).values({
      actorId: args.actorId,
      actorEmailSnapshot: snapshot,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      beforeJson: args.before === undefined ? null : (args.before as object),
      afterJson: args.after === undefined ? null : (args.after as object),
      requestId: args.requestId ?? null,
      ipAddress: args.ipAddress ?? null,
    });
  } catch (err) {
    logger.error("audit.write_failed", {
      action: args.action,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
