import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPermissions,
  requireSession,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  createStaticListMembers,
  listStaticListMembersForList,
} from "@/lib/marketing/lists/static-members";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { eq } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * REST endpoint for static-imported list member CRUD.
 *
 * GET /api/v1/marketing/lists/<id>/members/static
 * Paginated member listing, searchable / sortable.
 * POST /api/v1/marketing/lists/<id>/members/static
 * Bulk-create members. Body: { members: [{ email, name? }, ...] }.
 *
 * Single-row update / remove flow through the server actions on the
 * detail page; this REST surface exists for the import wizard and
 * external integrations.
 */

const idSchema = z.string().uuid();

const querySchema = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(50),
  sort: z.enum(["name", "email", "added"]).optional().default("added"),
  dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

const postBodySchema = z.object({
  members: z
    .array(
      z.object({
        email: z.string().trim().email().max(320),
        name: z
          .string()
          .trim()
          .max(500)
          .optional()
          .transform((v) => (v === "" || v === undefined ? null : v)),
      }),
    )
    .min(1)
    .max(5000),
});

async function requireListAccess(listId: string) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (
    !user.isAdmin &&
    !perms.canManageMarketing &&
    !perms.canMarketingListsView
  ) {
    throw new ForbiddenError("Marketing access required.");
  }
  const [list] = await db
    .select({
      id: marketingLists.id,
      isDeleted: marketingLists.isDeleted,
      listType: marketingLists.listType,
      createdById: marketingLists.createdById,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, listId))
    .limit(1);
  if (!list || list.isDeleted) throw new NotFoundError("marketing list");
  if (list.listType !== "static_imported") {
    throw new ValidationError(
      "This endpoint is only valid for static-imported lists.",
    );
  }
  return { user, list };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.members.static.list" },
    async () => {
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      await requireListAccess(id);
      const url = new URL(req.url);
      const parsed = querySchema.safeParse(
        Object.fromEntries(url.searchParams.entries()),
      );
      if (!parsed.success) throw new ValidationError("Invalid query.");
      const result = await listStaticListMembersForList(id, {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        search: parsed.data.q,
        sortKey: parsed.data.sort,
        sortDir: parsed.data.dir,
      });
      return {
        data: result.rows,
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      };
    },
  );
  if (!result.ok) {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result.data);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.members.static.create" },
    async () => {
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      const { user, list } = await requireListAccess(id);
      const perms = await getPermissions(user.id);
      if (
        !user.isAdmin &&
        !perms.canMarketingListsImport &&
        !perms.canMarketingListsCreate &&
        list.createdById !== user.id
      ) {
        throw new ForbiddenError(
          "You don't have permission to add static members.",
        );
      }
      const json = await req.json().catch(() => null);
      const parsed = postBodySchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Invalid body.",
        );
      }

      const { inserted } = await createStaticListMembers({
        listId: id,
        members: parsed.data.members,
        actorId: user.id,
      });

      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.LIST_MEMBER_ADDED,
        targetType: "marketing_list",
        targetId: id,
        after: {
          inserted,
          requested: parsed.data.members.length,
        },
      });

      return { inserted };
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
