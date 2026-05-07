import "server-only";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";

/**
 * Append an audit event. Best-effort — we never want a write failure to
 * block the actual mutation it's recording, so we catch and log.
 */
export async function writeAudit(args: {
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
  ipAddress?: string;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: args.actorId,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      beforeJson: args.before === undefined ? null : (args.before as object),
      afterJson: args.after === undefined ? null : (args.after as object),
      requestId: args.requestId ?? null,
      ipAddress: args.ipAddress ?? null,
    });
  } catch (err) {
    console.error(
      "[audit] write failed",
      args.action,
      err instanceof Error ? err.message : err,
    );
  }
}
