import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import {
  getPermissions,
  requireSession,
  type MarketingPermissionKey,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { refreshList } from "@/lib/marketing/lists/refresh";
import { filterDslSchema } from "@/lib/security/filter-dsl";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal marketing-lists single-record endpoint.
 *
 * GET reads. PUT updates name/description/filterDsl (mass-assignment
 * gate keeps system fields like memberCount/lastRefreshedAt out of
 * caller control). DELETE soft-archives.
 */

const idSchema = z.string().uuid();

const putBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  filterDsl: filterDslSchema,
});

async function requireListApiAccess(perm: MarketingPermissionKey) {
  const user = await requireSession();
  if (user.isAdmin) return user;
  const perms = await getPermissions(user.id);
  if (!perms[perm]) {
    throw new ForbiddenError("Marketing access required.");
  }
  return user;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.get" },
    async () => {
      await requireListApiAccess("canMarketingListsView");
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      const [row] = await db
        .select()
        .from(marketingLists)
        .where(eq(marketingLists.id, id))
        .limit(1);
      if (!row || row.isDeleted) throw new NotFoundError("marketing list");
      return row;
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data);
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.update" },
    async () => {
      const user = await requireListApiAccess("canMarketingListsEdit");
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      const json = await req.json().catch(() => null);
      const parsed = putBodySchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid body.",
        );
      }

      const [existing] = await db
        .select({
          id: marketingLists.id,
          name: marketingLists.name,
          description: marketingLists.description,
          filterDsl: marketingLists.filterDsl,
          isDeleted: marketingLists.isDeleted,
        })
        .from(marketingLists)
        .where(eq(marketingLists.id, id))
        .limit(1);
      if (!existing || existing.isDeleted) {
        throw new NotFoundError("marketing list");
      }

      // Mass-assignment guard: the schema constrains writable keys to
      // name/description/filterDsl. memberCount, lastRefreshedAt,
      // createdById, etc., are managed by the system.
      await db
        .update(marketingLists)
        .set({
          name: parsed.data.name,
          description: parsed.data.description,
          filterDsl: parsed.data.filterDsl,
          updatedById: user.id,
          updatedAt: sql`now()`,
        })
        .where(eq(marketingLists.id, id));

      // surface non-validation refresh failures via
      // logger.warn so they're visible in production diagnostics.
      // The list update already landed; membership stays stale until
      // the next refresh.
      try {
        await refreshList(id, user.id);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        logger.warn("marketing.list.refresh_after_update_failed", {
          listId: id,
          userId: user.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_UPDATE,
        targetType: "marketing_list",
        targetId: id,
        before: {
          name: existing.name,
          description: existing.description,
          filterDsl: existing.filterDsl,
        },
        after: {
          name: parsed.data.name,
          description: parsed.data.description,
          filterDsl: parsed.data.filterDsl,
        },
      });

      return { id };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data);
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.delete" },
    async () => {
      const user = await requireListApiAccess("canMarketingListsDelete");
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }

      const [existing] = await db
        .select({
          id: marketingLists.id,
          name: marketingLists.name,
          isDeleted: marketingLists.isDeleted,
        })
        .from(marketingLists)
        .where(eq(marketingLists.id, id))
        .limit(1);
      if (!existing || existing.isDeleted) {
        throw new NotFoundError("marketing list");
      }

      await db
        .update(marketingLists)
        .set({
          isDeleted: true,
          deletedAt: sql`now()`,
          deletedById: user.id,
          updatedAt: sql`now()`,
        })
        .where(eq(marketingLists.id, id));

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_DELETE,
        targetType: "marketing_list",
        targetId: id,
        before: { name: existing.name },
      });
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return new Response(null, { status: 204 });
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
