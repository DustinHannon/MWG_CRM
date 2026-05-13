import { NextResponse } from "next/server";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import {
  getPermissions,
  requireSession,
  type MarketingPermissionKey,
} from "@/lib/auth-helpers";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { likeContains } from "@/lib/security/like-escape";
import { filterDslSchema } from "@/lib/security/filter-dsl";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { refreshList } from "@/lib/marketing/lists/refresh";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Internal marketing-lists CRUD endpoint.
 *
 * Session-based (not API-key like /api/v1/leads). Used by the marketing
 * UI's list picker, live preview, and detail/edit pages.
 */

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  filterDsl: filterDslSchema,
});

async function requireListsApiAccess(perm: MarketingPermissionKey) {
  const user = await requireSession();
  if (user.isAdmin) return user;
  const perms = await getPermissions(user.id);
  if (!perms[perm]) {
    throw new ForbiddenError("Marketing access required.");
  }
  return user;
}

export async function GET(req: Request) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.list" },
    async () => {
      await requireListsApiAccess("canMarketingListsView");
      const url = new URL(req.url);
      const parsed = listQuerySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!parsed.success) {
        throw new ValidationError("Invalid query.");
      }
      const { search, page, pageSize } = parsed.data;
      const where = and(
        eq(marketingLists.isDeleted, false),
        search ? ilike(marketingLists.name, likeContains(search)) : undefined,
      );

      const offset = (page - 1) * pageSize;
      const rows = await db
        .select({
          id: marketingLists.id,
          name: marketingLists.name,
          description: marketingLists.description,
          // surface list_type + source_entity so the
          // internal list-picker and integrations can branch UI.
          listType: marketingLists.listType,
          sourceEntity: marketingLists.sourceEntity,
          memberCount: marketingLists.memberCount,
          lastRefreshedAt: marketingLists.lastRefreshedAt,
          updatedAt: marketingLists.updatedAt,
          createdByName: users.displayName,
        })
        .from(marketingLists)
        .leftJoin(users, eq(users.id, marketingLists.createdById))
        .where(where)
        .orderBy(desc(marketingLists.updatedAt))
        .limit(pageSize)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(marketingLists)
        .where(where);

      return {
        data: rows,
        meta: {
          page,
          pageSize,
          total: total ?? 0,
          totalPages: Math.max(1, Math.ceil((total ?? 0) / pageSize)),
        },
      };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data);
}

export async function POST(req: Request) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.create" },
    async () => {
      const user = await requireListsApiAccess("canMarketingListsCreate");
      const json = await req.json().catch(() => null);
      const parsed = createBodySchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid body.",
        );
      }

      const [row] = await db
        .insert(marketingLists)
        .values({
          name: parsed.data.name,
          description: parsed.data.description,
          filterDsl: parsed.data.filterDsl,
          createdById: user.id,
          updatedById: user.id,
        })
        .returning({ id: marketingLists.id });
      if (!row) throw new ValidationError("Failed to create list.");

      // surface non-validation refresh failures via
      // logger.warn. The list row already exists; membership stays
      // empty until next refresh.
      try {
        await refreshList(row.id, user.id);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        logger.warn("marketing.list.refresh_after_create_failed", {
          listId: row.id,
          userId: user.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_CREATE,
        targetType: "marketing_list",
        targetId: row.id,
        after: {
          name: parsed.data.name,
          filterDsl: parsed.data.filterDsl,
        },
      });

      return { id: row.id };
    },
  );

  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data, { status: 201 });
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
