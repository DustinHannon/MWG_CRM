import "server-only";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listMarketingListsCursor`. Mirrors the
 * columns the marketing lists page renders (name + type pill + member
 * count + last refreshed + creator + updated).
 */
export interface MarketingListRow {
  id: string;
  name: string;
  listType: "dynamic" | "static_imported";
  memberCount: number;
  lastRefreshedAt: Date | null;
  updatedAt: Date;
  createdByName: string | null;
}

export interface MarketingListCursorFilters {
  search?: string;
  type?: "dynamic" | "static_imported" | "all";
}

/**
 * Cursor-paginated list of marketing lists.
 *
 * Default sort: `(updated_at DESC, id DESC)`. `updated_at` is NOT NULL
 * on `marketing_lists` so the cursor codec stays simple.
 *
 * Visibility: marketing list rows are visible to anyone with the
 * `canMarketingListsView` permission today. The list catalog is shared
 * across the marketing team; per-user scoping isn't part of the
 * model — call sites can layer it on if a future phase introduces
 * personal lists.
 */
export async function listMarketingListsCursor(args: {
  filters: MarketingListCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: MarketingListRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { filters } = args;

  const wheres: SQL[] = [eq(marketingLists.isDeleted, false)];

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(ilike(marketingLists.name, pattern));
  }
  if (filters.type && filters.type !== "all") {
    wheres.push(eq(marketingLists.listType, filters.type));
  }

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) return undefined;
    return sql`(
      ${marketingLists.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${marketingLists.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${marketingLists.id} < ${parsedCursor.id})
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: marketingLists.id,
        name: marketingLists.name,
        listType: marketingLists.listType,
        memberCount: marketingLists.memberCount,
        lastRefreshedAt: marketingLists.lastRefreshedAt,
        updatedAt: marketingLists.updatedAt,
        createdByName: users.displayName,
      })
      .from(marketingLists)
      .leftJoin(users, eq(users.id, marketingLists.createdById))
      .where(finalWhere)
      .orderBy(desc(marketingLists.updatedAt), desc(marketingLists.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingLists)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.updatedAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
