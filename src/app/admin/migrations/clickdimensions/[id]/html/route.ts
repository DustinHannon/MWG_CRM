import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clickdimensionsMigrations } from "@/db/schema/clickdimensions-migrations";
import { permissions } from "@/db/schema/users";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves the captured raw HTML for a single migration
 * row. Permission gate matches the worklist UI: admin OR
 * canMarketingMigrationsRun. Returns 404 if the row doesn't exist OR
 * no HTML was captured.
 *
 * Content-Type is text/plain (NOT text/html) so a browser never
 * interprets the captured payload — the worklist dialog renders it in
 * a sandboxed iframe for preview, and in a <pre> block for raw view.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireSession();
  if (!user.isAdmin) {
    const perm = await db
      .select({
        canMarketingMigrationsRun: permissions.canMarketingMigrationsRun,
      })
      .from(permissions)
      .where(eq(permissions.userId, user.id))
      .limit(1);
    if (!perm[0]?.canMarketingMigrationsRun) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }
  const { id } = await params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return new NextResponse("Bad request", { status: 400 });
  }
  const rows = await db
    .select({
      rawHtml: clickdimensionsMigrations.rawHtml,
    })
    .from(clickdimensionsMigrations)
    .where(eq(clickdimensionsMigrations.id, id))
    .limit(1);
  if (!rows[0] || rows[0].rawHtml === null) {
    return new NextResponse("Not found", { status: 404 });
  }
  return new NextResponse(rows[0].rawHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
