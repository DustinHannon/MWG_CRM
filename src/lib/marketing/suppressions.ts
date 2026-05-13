import "server-only";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { users } from "@/db/schema/users";
import {
  SUPPRESSION_TYPES,
  type MarketingSuppressionRow,
  type SuppressionType,
} from "./suppressions-types";

// Re-export for callers that already import these names from this
// module path. New code should import from `./suppressions-types`
// directly to keep the server-only barrier explicit.
export { SUPPRESSION_TYPES };
export type { MarketingSuppressionRow, SuppressionType };

export interface MarketingSuppressionCursorFilters {
  search?: string;
  source?: SuppressionType | "all";
}

/**
 * Suppressions has no uuid `id` — `email` is the primary key — so the
 * canonical `@/lib/cursors` codec (which validates `id` as a uuid)
 * doesn't fit. A local opaque cursor with shape
 * `{ ts: iso8601, email: string }` covers the `(suppressed_at, email)`
 * tuple sort instead. Same base64url + tolerant decode contract as the
 * canonical codec.
 */
const suppressionCursorSchema = z.object({
  ts: z.string().datetime({ offset: true }),
  email: z.string().min(1),
});

interface ParsedSuppressionCursor {
  ts: Date;
  email: string;
}

function encodeSuppressionCursor(ts: Date, email: string): string {
  return Buffer.from(
    JSON.stringify({ ts: ts.toISOString(), email }),
    "utf8",
  ).toString("base64url");
}

function decodeSuppressionCursor(
  raw: string | null | undefined,
): ParsedSuppressionCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const result = suppressionCursorSchema.safeParse(parsed);
  if (!result.success) return null;
  const ts = new Date(result.data.ts);
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, email: result.data.email };
}

/**
 * Cursor-paginated list of marketing suppressions.
 *
 * Default sort: `(suppressed_at DESC, email DESC)`. Most rows are
 * mirrored from SendGrid by the hourly cron + event webhook; admins
 * can manually add or remove rows from the page.
 */
export async function listSuppressionsCursor(args: {
  filters: MarketingSuppressionCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: MarketingSuppressionRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { filters } = args;

  const wheres: SQL[] = [];

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(ilike(marketingSuppressions.email, pattern));
  }
  if (filters.source && filters.source !== "all") {
    wheres.push(eq(marketingSuppressions.suppressionType, filters.source));
  }

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  const parsedCursor = decodeSuppressionCursor(args.cursor);
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    return sql`(
      ${marketingSuppressions.suppressedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${marketingSuppressions.suppressedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${marketingSuppressions.email} < ${parsedCursor.email})
    )`;
  })();

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        email: marketingSuppressions.email,
        suppressionType: marketingSuppressions.suppressionType,
        reason: marketingSuppressions.reason,
        suppressedAt: marketingSuppressions.suppressedAt,
        syncedAt: marketingSuppressions.syncedAt,
        addedByUserId: marketingSuppressions.addedByUserId,
        addedByName: users.displayName,
      })
      .from(marketingSuppressions)
      .leftJoin(users, eq(users.id, marketingSuppressions.addedByUserId))
      .where(finalWhere)
      .orderBy(
        desc(marketingSuppressions.suppressedAt),
        desc(marketingSuppressions.email),
      )
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingSuppressions)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeSuppressionCursor(last.suppressedAt, last.email);
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
