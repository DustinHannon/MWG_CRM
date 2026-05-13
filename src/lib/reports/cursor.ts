import "server-only";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { savedReports } from "@/db/schema/saved-reports";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import type { ReportListItem } from "./repository";

export interface ReportsCursorFilters {
  search?: string;
  scope?: "all" | "mine" | "shared";
}

/**
 * Cursor-paginated list of user + shared (non-built-in) saved reports.
 *
 * Default sort: `(updated_at DESC, id DESC)`. The composite index
 * `saved_reports_owner_updated_idx` and the `shared` index back the
 * scoping queries.
 *
 * Visibility scoping:
 * - `mine`: owner = viewerId.
 * - `shared`: owner != viewerId AND is_shared = true.
 * - `all` (default): owner = viewerId OR is_shared = true.
 */
export async function listReportsCursor(args: {
  viewerId: string;
  filters: ReportsCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ReportListItem[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { viewerId, filters } = args;

  const wheres: SQL[] = [
    eq(savedReports.isBuiltin, false),
    eq(savedReports.isDeleted, false),
  ];

  const scope = filters.scope ?? "all";
  if (scope === "mine") {
    wheres.push(eq(savedReports.ownerId, viewerId));
  } else if (scope === "shared") {
    wheres.push(
      and(
        sql`${savedReports.ownerId} != ${viewerId}`,
        eq(savedReports.isShared, true),
      )!,
    );
  } else {
    wheres.push(
      or(
        eq(savedReports.ownerId, viewerId),
        eq(savedReports.isShared, true),
      )!,
    );
  }

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(
      or(
        ilike(savedReports.name, pattern),
        ilike(savedReports.description, pattern),
      )!,
    );
  }

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor || parsedCursor.ts === null) return undefined;
    return sql`(
      ${savedReports.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${savedReports.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${savedReports.id} < ${parsedCursor.id}::uuid)
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: savedReports.id,
        name: savedReports.name,
        description: savedReports.description,
        entityType: savedReports.entityType,
        visualization: savedReports.visualization,
        isShared: savedReports.isShared,
        isBuiltin: savedReports.isBuiltin,
        ownerId: savedReports.ownerId,
        ownerName: users.displayName,
        updatedAt: savedReports.updatedAt,
      })
      .from(savedReports)
      .leftJoin(users, eq(users.id, savedReports.ownerId))
      .where(finalWhere)
      .orderBy(desc(savedReports.updatedAt), desc(savedReports.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(savedReports)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.updatedAt, last.id, "desc");
  }

  return { data, nextCursor, total: totalRow[0]?.count ?? 0 };
}
