import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema/api-keys";
import { users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { decodeCursor, encodeFromValues } from "@/lib/cursors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_SIZE = 50;

/**
 * Internal cursor-paginated list endpoint backing the admin API keys
 * page. Session-authenticated. Admin-only.
 *
 * Default sort: `(created_at DESC, id DESC)`.
 *
 * Accepts:
 *   ?cursor=<opaque>  — null on first page.
 *   ?q                — search term (matches name / description / prefix).
 *   ?status           — all | active | revoked | expired.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export async function GET(req: NextRequest) {
  await requireAdmin();

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");
  const q = sp.get("q")?.trim() ?? "";
  const status = sp.get("status") ?? "all";

  const wheres: SQL[] = [];
  if (q) {
    const pattern = `%${q}%`;
    wheres.push(
      or(
        ilike(apiKeys.name, pattern),
        ilike(apiKeys.description, pattern),
        ilike(apiKeys.keyPrefix, pattern),
      )!,
    );
  }
  if (status === "active") {
    wheres.push(sql`${apiKeys.revokedAt} IS NULL`);
    wheres.push(
      sql`(${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now())`,
    );
  } else if (status === "revoked") {
    wheres.push(sql`${apiKeys.revokedAt} IS NOT NULL`);
  } else if (status === "expired") {
    wheres.push(sql`${apiKeys.revokedAt} IS NULL`);
    wheres.push(sql`${apiKeys.expiresAt} IS NOT NULL`);
    wheres.push(sql`${apiKeys.expiresAt} <= now()`);
  }

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  const parsedCursor = decodeCursor(cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor || parsedCursor.ts === null) return undefined;
    return sql`(
      ${apiKeys.createdAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${apiKeys.createdAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${apiKeys.id} < ${parsedCursor.id}::uuid)
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
        id: apiKeys.id,
        name: apiKeys.name,
        description: apiKeys.description,
        prefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        rateLimitPerMinute: apiKeys.rateLimitPerMinute,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        lastUsedIp: apiKeys.lastUsedIp,
        createdAt: apiKeys.createdAt,
        createdByName: users.displayName,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdById))
      .where(finalWhere)
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(PAGE_SIZE + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > PAGE_SIZE) {
    data = rowsRaw.slice(0, PAGE_SIZE);
    const last = data[data.length - 1];
    nextCursor = encodeFromValues(last.createdAt, last.id, "desc");
  }

  return NextResponse.json({
    data: data.map((r) => ({
      ...r,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  });
}
