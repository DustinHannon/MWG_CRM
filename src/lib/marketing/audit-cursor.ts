import "server-only";
import { and, desc, eq, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listMarketingAuditCursor`. Mirrors the
 * columns the marketing audit page renders.
 */
export interface MarketingAuditRow {
  id: string;
  actorId: string | null;
  actorEmailSnapshot: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  // jsonb columns surface as `unknown` from drizzle's select; pages
  // forward to the inspect drawer as `unknown` and JSON.stringify on
  // render.
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: Date;
  actorDisplayName: string | null;
}

export interface MarketingAuditCursorFilters {
  search?: string;
  type?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Cursor-paginated list of `marketing.*` audit events.
 *
 * Default sort: `(created_at DESC, id DESC)`. The composite index
 * `audit_log_created_at_id_idx` on `(created_at DESC, id DESC)` backs
 * this ordering. `created_at` is NOT NULL.
 *
 * Visibility:
 * - Admin can filter by any `userId` (passed through `filters.userId`).
 * - Non-admin only sees their own actions + system-fired events
 *   (`actor_id IS NULL`); the caller passes `nonAdminUserId` to apply
 *   that scoping.
 */
export async function listMarketingAuditCursor(args: {
  filters: MarketingAuditCursorFilters;
  /** When set, scopes results to actor = userId OR actor IS NULL. */
  nonAdminUserId?: string;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: MarketingAuditRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 100;
  const { filters, nonAdminUserId } = args;

  // Always scope to marketing.* events.
  const wheres: SQL[] = [ilike(auditLog.action, "marketing.%")];

  if (nonAdminUserId) {
    wheres.push(
      sql`(${auditLog.actorId} = ${nonAdminUserId} OR ${auditLog.actorId} IS NULL)`,
    );
  } else if (filters.userId) {
    wheres.push(eq(auditLog.actorId, filters.userId));
  }

  if (filters.type) {
    const t = filters.type.startsWith("marketing.")
      ? filters.type
      : `marketing.${filters.type}`;
    wheres.push(ilike(auditLog.action, `${t}%`));
  }

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(ilike(auditLog.action, pattern));
  }

  if (filters.from) wheres.push(gte(auditLog.createdAt, filters.from));
  if (filters.to) wheres.push(lte(auditLog.createdAt, filters.to));

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) return undefined;
    return sql`(
      ${auditLog.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${auditLog.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${auditLog.id} < ${parsedCursor.id})
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorId: auditLog.actorId,
        actorEmailSnapshot: auditLog.actorEmailSnapshot,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        createdAt: auditLog.createdAt,
        actorDisplayName: users.displayName,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(finalWhere)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.createdAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
