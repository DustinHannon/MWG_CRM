import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getPermissions,
  requireSession,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  ValidationError,
} from "@/lib/errors";
import { refreshList } from "@/lib/marketing/lists/refresh";
import { withErrorBoundary } from "@/lib/server-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const idSchema = z.string().uuid();

/**
 * Trigger an on-demand refresh of a list's membership.
 * Mirrors the daily cron's call but attributes the audit row to the
 * acting user.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const result = await withErrorBoundary(
    { action: "marketing.lists.refresh" },
    async () => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canMarketingListsRefresh) {
        throw new ForbiddenError("Marketing access required.");
      }
      const { id } = await ctx.params;
      if (!idSchema.safeParse(id).success) {
        throw new ValidationError("Invalid list id.");
      }
      const r = await refreshList(id, user.id);
      return {
        added: r.added,
        removed: r.removed,
        total: r.total,
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
