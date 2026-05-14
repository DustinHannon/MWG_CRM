import { NextResponse, type NextRequest } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { users } from "@/db/schema/users";
import { withInternalListApi } from "@/lib/api/internal-list";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal list endpoint backing the admin imports/remap page.
 * Session-authenticated. Admin-only.
 *
 * Returns:
 *   {
 *     pending: [{ name, count, mostRecent }, ...],   // grouped by name DESC count
 *     users:   [{ id, displayName, email }, ...],    // active users for the picker
 *   }
 *
 * The pending list is genuinely bounded (one row per unique
 * unresolved imported-by name) and small in practice. No cursor
 * pagination — but wraps in the same shape as other list endpoints
 * for symmetry with `StandardListPagePage`.
 */
export const GET = withInternalListApi(
  { action: "admin.imports_remap.list", auth: "admin" },
  async (_req: NextRequest) => {
  const [pending, allUsers] = await Promise.all([
    db
      .select({
        name: activities.importedByName,
        count: sql<number>`count(*)::int`,
        mostRecent: sql<Date>`max(${activities.createdAt})`,
      })
      .from(activities)
      .where(
        sql`${activities.importedByName} IS NOT NULL AND ${activities.userId} IS NULL AND ${activities.isDeleted} = false`,
      )
      .groupBy(activities.importedByName)
      .orderBy(sql`count(*) DESC`),
    db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
      })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.displayName)),
  ]);

  return NextResponse.json({
    data: pending.map((p) => ({
      name: p.name,
      count: p.count,
      mostRecent:
        p.mostRecent instanceof Date
          ? p.mostRecent.toISOString()
          : String(p.mostRecent),
    })),
    nextCursor: null,
    total: pending.length,
    users: allUsers,
  });
  },
);
