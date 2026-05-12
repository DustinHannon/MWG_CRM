import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  marketingListMembers,
  marketingLists,
} from "@/db/schema/marketing-lists";
import {
  getPermissions,
  requireSession,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

/**
 * Paginated members of a marketing list. JOINs leads so the
 * caller gets first/last name and status without a second round trip.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.members.list" },
    async () => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canManageMarketing) {
        throw new ForbiddenError("Marketing access required.");
      }
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      const url = new URL(req.url);
      const parsed = querySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!parsed.success) throw new ValidationError("Invalid query.");

      const [list] = await db
        .select({ id: marketingLists.id, isDeleted: marketingLists.isDeleted })
        .from(marketingLists)
        .where(eq(marketingLists.id, id))
        .limit(1);
      if (!list || list.isDeleted) throw new NotFoundError("marketing list");

      const offset = (parsed.data.page - 1) * parsed.data.pageSize;
      const rows = await db
        .select({
          id: leads.id,
          email: marketingListMembers.email,
          firstName: leads.firstName,
          lastName: leads.lastName,
          status: leads.status,
          addedAt: marketingListMembers.addedAt,
        })
        .from(marketingListMembers)
        .leftJoin(leads, eq(leads.id, marketingListMembers.leadId))
        .where(eq(marketingListMembers.listId, id))
        .orderBy(desc(marketingListMembers.addedAt))
        .limit(parsed.data.pageSize)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(marketingListMembers)
        .where(eq(marketingListMembers.listId, id));

      return {
        data: rows,
        meta: {
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          total: total ?? 0,
          totalPages: Math.max(
            1,
            Math.ceil((total ?? 0) / parsed.data.pageSize),
          ),
        },
      };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data);
}

function statusFor(code: string): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "RATE_LIMIT":
      return 429;
    case "REAUTH_REQUIRED":
      return 401;
    default:
      return 500;
  }
}
