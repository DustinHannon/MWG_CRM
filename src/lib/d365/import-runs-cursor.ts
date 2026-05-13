import "server-only";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, importRuns } from "@/db/schema/d365-imports";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import { D365_ENTITY_TYPES } from "@/lib/d365/types";

const RUN_STATUSES = [
  "created",
  "fetching",
  "mapping",
  "reviewing",
  "committing",
  "paused_for_review",
  "completed",
  "aborted",
] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

export interface ImportRunRow {
  id: string;
  entityType: string;
  status: string;
  createdAt: Date;
  createdById: string | null;
  createdByName: string | null;
  totalBatches: number;
  doneBatches: number;
  committedRecords: number;
}

export interface ImportRunsCursorFilters {
  status?: string;
  entity?: string;
}

/**
 * Cursor-paginated list of d365 import runs.
 *
 * Default sort: `(created_at DESC, id DESC)`. Per-run batch aggregates
 * are returned alongside the run rows so the table can render
 * `done / total` and `records committed` without an N+1 follow-up.
 */
export async function listImportRunsCursor(args: {
  filters: ImportRunsCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ImportRunRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { filters } = args;

  const wheres: SQL[] = [];
  if (
    filters.status &&
    (RUN_STATUSES as readonly string[]).includes(filters.status)
  ) {
    wheres.push(eq(importRuns.status, filters.status as RunStatus));
  }
  if (
    filters.entity &&
    (D365_ENTITY_TYPES as readonly string[]).includes(filters.entity)
  ) {
    wheres.push(eq(importRuns.entityType, filters.entity));
  }

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor || parsedCursor.ts === null) return undefined;
    return sql`(
      ${importRuns.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${importRuns.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${importRuns.id} < ${parsedCursor.id}::uuid)
    )`;
  })();

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  const [runRows, totalRow] = await Promise.all([
    db
      .select({
        id: importRuns.id,
        entityType: importRuns.entityType,
        status: importRuns.status,
        createdAt: importRuns.createdAt,
        createdById: importRuns.createdById,
        createdByName: users.displayName,
      })
      .from(importRuns)
      .leftJoin(users, eq(users.id, importRuns.createdById))
      .where(finalWhere)
      .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(importRuns)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let visibleRuns = runRows;
  if (runRows.length > pageSize) {
    visibleRuns = runRows.slice(0, pageSize);
    const last = visibleRuns[visibleRuns.length - 1];
    nextCursor = encodeStandardCursor(last.createdAt, last.id, "desc");
  }

  // Per-run batch aggregates — a single GROUP BY against the visible
  // set of runs. Empty array shortcircuits to skip the query.
  const runIds = visibleRuns.map((r) => r.id);
  const batchAggBy = new Map<
    string,
    { totalBatches: number; doneBatches: number; committedRecords: number }
  >();
  if (runIds.length > 0) {
    const batchAgg = await db
      .select({
        runId: importBatches.runId,
        totalBatches: count(importBatches.id),
        doneBatches: sql<number>`SUM(CASE WHEN ${importBatches.status} = 'committed' THEN 1 ELSE 0 END)`,
        committedRecords: sql<number>`COALESCE(SUM(${importBatches.recordCountCommitted}), 0)`,
      })
      .from(importBatches)
      .where(inArray(importBatches.runId, runIds))
      .groupBy(importBatches.runId);
    for (const row of batchAgg) {
      batchAggBy.set(row.runId, {
        totalBatches: Number(row.totalBatches ?? 0),
        doneBatches: Number(row.doneBatches ?? 0),
        committedRecords: Number(row.committedRecords ?? 0),
      });
    }
  }

  return {
    data: visibleRuns.map((r) => {
      const agg = batchAggBy.get(r.id) ?? {
        totalBatches: 0,
        doneBatches: 0,
        committedRecords: 0,
      };
      return {
        ...r,
        totalBatches: agg.totalBatches,
        doneBatches: agg.doneBatches,
        committedRecords: agg.committedRecords,
      };
    }),
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
