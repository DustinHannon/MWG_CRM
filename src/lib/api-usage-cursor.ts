import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, apiUsageLog } from "@/db/schema/api-keys";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

export interface ApiUsageRow {
  id: string;
  createdAt: Date;
  apiKeyId: string | null;
  apiKeyNameSnapshot: string;
  apiKeyPrefixSnapshot: string;
  method: string;
  path: string;
  action: string | null;
  statusCode: number;
  responseTimeMs: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestQuery: unknown;
  requestBodySummary: unknown;
  responseSummary: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export const STATUS_BUCKETS = [
  { value: "2xx", min: 200, max: 299 },
  { value: "3xx", min: 300, max: 399 },
  { value: "4xx", min: 400, max: 499 },
  { value: "5xx", min: 500, max: 599 },
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number]["value"];

export interface ApiUsageCursorFilters {
  search?: string;
  method?: string;
  path?: string;
  statusBuckets?: StatusBucket[];
  apiKeyIds?: string[];
  from?: Date;
  to?: Date;
}

/**
 * Cursor-paginated list of api_usage_log entries.
 *
 * Default sort: `(created_at DESC, id DESC)`. The composite index
 * `api_usage_log_created_idx` backs this ordering.
 */
export async function listApiUsageCursor(args: {
  filters: ApiUsageCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ApiUsageRow[];
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
        ilike(apiUsageLog.action, pattern),
        ilike(apiUsageLog.errorMessage, pattern),
        ilike(apiUsageLog.apiKeyNameSnapshot, pattern),
      )!,
    );
  }
  if (filters.method) wheres.push(eq(apiUsageLog.method, filters.method));
  if (filters.path) {
    wheres.push(ilike(apiUsageLog.path, `%${filters.path}%`));
  }
  if (filters.statusBuckets && filters.statusBuckets.length > 0) {
    const ranges = filters.statusBuckets
      .map((bucket) => STATUS_BUCKETS.find((b) => b.value === bucket))
      .filter((b): b is (typeof STATUS_BUCKETS)[number] => Boolean(b));
    if (ranges.length > 0) {
      const ors = ranges.map(
        (b) =>
          sql`(${apiUsageLog.statusCode} >= ${b.min} AND ${apiUsageLog.statusCode} <= ${b.max})`,
      );
      wheres.push(or(...ors)!);
    }
  }
  if (filters.apiKeyIds && filters.apiKeyIds.length > 0) {
    wheres.push(inArray(apiUsageLog.apiKeyId, filters.apiKeyIds));
  }
  if (filters.from) wheres.push(gte(apiUsageLog.createdAt, filters.from));
  if (filters.to) wheres.push(lte(apiUsageLog.createdAt, filters.to));

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor || parsedCursor.ts === null) return undefined;
    return sql`(
      ${apiUsageLog.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${apiUsageLog.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${apiUsageLog.id} < ${parsedCursor.id}::uuid)
    )`;
  })();

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  // Guard slow searches.
  if (filters.search) {
    await db.execute(sql`SET LOCAL statement_timeout = '5s'`);
  }

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: apiUsageLog.id,
        createdAt: apiUsageLog.createdAt,
        apiKeyId: apiUsageLog.apiKeyId,
        apiKeyNameSnapshot: apiUsageLog.apiKeyNameSnapshot,
        apiKeyPrefixSnapshot: apiUsageLog.apiKeyPrefixSnapshot,
        method: apiUsageLog.method,
        path: apiUsageLog.path,
        action: apiUsageLog.action,
        statusCode: apiUsageLog.statusCode,
        responseTimeMs: apiUsageLog.responseTimeMs,
        ipAddress: apiUsageLog.ipAddress,
        userAgent: apiUsageLog.userAgent,
        requestQuery: apiUsageLog.requestQuery,
        requestBodySummary: apiUsageLog.requestBodySummary,
        responseSummary: apiUsageLog.responseSummary,
        errorCode: apiUsageLog.errorCode,
        errorMessage: apiUsageLog.errorMessage,
      })
      .from(apiUsageLog)
      .where(finalWhere)
      .orderBy(desc(apiUsageLog.createdAt), desc(apiUsageLog.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiUsageLog)
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
 * List of API keys (for the filter dropdown). Sorted alphabetically by
 * name; includes revoked entries so the dropdown can label them.
 */
export async function listApiKeysForFilter(): Promise<
  Array<{ id: string; name: string; prefix: string; revokedAt: Date | null }>
> {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.keyPrefix,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .orderBy(asc(apiKeys.name));
}
