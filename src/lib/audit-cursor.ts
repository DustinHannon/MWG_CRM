import "server-only";
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listAuditLogCursor`. Mirrors the columns the
 * admin audit log page renders.
 */
export interface AuditLogRow {
  id: string;
  actorId: string | null;
  actorDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  requestId: string | null;
  createdAt: Date;
}

export interface AuditLogCursorFilters {
  search?: string;
  action?: string;
  targetType?: string;
  requestId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Cursor-paginated list of audit_log events for the admin surface.
 *
 * Default sort: `(created_at DESC, id DESC)`. The composite index
 * `audit_log_created_at_id_idx` on `(created_at DESC, id DESC)` backs
 * this ordering. `created_at` is NOT NULL.
 */
export async function listAuditLogCursor(args: {
  filters: AuditLogCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: AuditLogRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 100;
  const { filters } = args;

  const wheres: SQL[] = [];

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(
      or(
        ilike(auditLog.action, pattern),
        ilike(auditLog.targetType, pattern),
        ilike(auditLog.targetId, pattern),
        ilike(users.displayName, pattern),
        ilike(users.email, pattern),
      )!,
    );
  }
  if (filters.action) wheres.push(eq(auditLog.action, filters.action));
  if (filters.targetType) {
    wheres.push(eq(auditLog.targetType, filters.targetType));
  }
  if (filters.requestId) {
    wheres.push(eq(auditLog.requestId, filters.requestId));
  }
  if (filters.from) wheres.push(gte(auditLog.createdAt, filters.from));
  if (filters.to) wheres.push(lte(auditLog.createdAt, filters.to));

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) return undefined;
    return sql`(
      ${auditLog.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${auditLog.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${auditLog.id} < ${parsedCursor.id}::uuid)
    )`;
  })();

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  // Guard slow searches: ILIKE %q% across multiple text columns can be
  // expensive on a 1M-row audit log. 5s cap matches the prior surface.
  if (filters.search) {
    await db.execute(sql`SET LOCAL statement_timeout = '5s'`);
  }

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorId: auditLog.actorId,
        actorDisplayName: users.displayName,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        requestId: auditLog.requestId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorId, users.id))
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

/**
 * Distinct list of target_types present in audit_log. Used by the
 * filter dropdown — capped at a small bound and cached by the page.
 */
export async function listAuditTargetTypes(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ targetType: auditLog.targetType })
    .from(auditLog)
    .where(sql`${auditLog.targetType} IS NOT NULL`)
    .orderBy(auditLog.targetType);
  return rows
    .map((r) => r.targetType)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}
