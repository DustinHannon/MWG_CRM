import { NextResponse, type NextRequest } from "next/server";
import { and, asc, desc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { decodeCursor, encodeFromValues } from "@/lib/cursors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT_JIT_FILTER = "jit-7d";
const PAGE_SIZE = 50;

/**
 * Internal cursor-paginated list endpoint backing the admin users list.
 * Session-authenticated. Admin-only.
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches displayName / email / username).
 *   ?recent=jit-7d     — restrict to JIT-provisioned users from the last 7 days.
 *
 * Default sort: `(last_login_at DESC NULLS LAST, display_name ASC)`.
 * Recent filter swaps to `(jit_provisioned_at DESC, id DESC)`.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export async function GET(req: NextRequest) {
  await requireAdmin();

  const sp = req.nextUrl.searchParams;
  const isRecentFilter = sp.get("recent") === RECENT_JIT_FILTER;
  const q = sp.get("q")?.trim() ?? "";
  const cursorRaw = sp.get("cursor");

  const wheres: SQL[] = [];
  if (q) {
    const pattern = `%${q}%`;
    wheres.push(
      or(
        ilike(users.displayName, pattern),
        ilike(users.email, pattern),
        ilike(users.username, pattern),
      )!,
    );
  }
  if (isRecentFilter) {
    wheres.push(eq(users.jitProvisioned, true));
    wheres.push(gt(users.jitProvisionedAt, sql`now() - interval '7 days'`));
  }

  const baseWhere = wheres.length > 0 ? and(...wheres) : undefined;

  // Cursor handling differs by sort. Recent filter sorts by jit_provisioned_at;
  // default sort by last_login_at (NULLS LAST). Cursor is only emitted under
  // the recent filter, since default sort has too many NULLs to paginate
  // cleanly; default sort returns the entire small bounded list in one page.
  let cursorWhere: SQL | undefined;
  if (isRecentFilter && cursorRaw) {
    const parsed = decodeCursor(cursorRaw, "desc");
    if (parsed && parsed.ts !== null) {
      cursorWhere = sql`(
        ${users.jitProvisionedAt} < ${parsed.ts.toISOString()}::timestamptz
        OR (${users.jitProvisionedAt} = ${parsed.ts.toISOString()}::timestamptz AND ${users.id} < ${parsed.id}::uuid)
      )`;
    }
  }

  const finalWhere = cursorWhere
    ? baseWhere
      ? and(baseWhere, cursorWhere)
      : cursorWhere
    : baseWhere;

  const baseSelect = {
    id: users.id,
    username: users.username,
    email: users.email,
    displayName: users.displayName,
    isAdmin: users.isAdmin,
    isBreakglass: users.isBreakglass,
    isActive: users.isActive,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
    jitProvisioned: users.jitProvisioned,
    jitProvisionedAt: users.jitProvisionedAt,
    photoUrl: users.photoBlobUrl,
    leadCount: sql<number>`(SELECT count(*)::int FROM ${leads} WHERE owner_id = ${users.id})`,
  };

  const [rowsRaw, totalRow] = await Promise.all([
    isRecentFilter
      ? db
          .select(baseSelect)
          .from(users)
          .where(finalWhere)
          .orderBy(desc(users.jitProvisionedAt), desc(users.id))
          .limit(PAGE_SIZE + 1)
      : db
          .select(baseSelect)
          .from(users)
          .where(finalWhere)
          .orderBy(
            sql`${users.lastLoginAt} desc nulls last`,
            asc(users.displayName),
          )
          .limit(PAGE_SIZE + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > PAGE_SIZE) {
    data = rowsRaw.slice(0, PAGE_SIZE);
    if (isRecentFilter) {
      const last = data[data.length - 1];
      if (last.jitProvisionedAt) {
        nextCursor = encodeFromValues(last.jitProvisionedAt, last.id, "desc");
      }
    }
  }

  return NextResponse.json({
    data: data.map((u) => ({
      ...u,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
      jitProvisionedAt: u.jitProvisionedAt
        ? u.jitProvisionedAt.toISOString()
        : null,
    })),
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  });
}
