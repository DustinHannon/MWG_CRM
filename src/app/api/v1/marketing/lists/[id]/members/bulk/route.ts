import { NextResponse } from "next/server";
import { z } from "zod";
import { bulkAddLeadsToListAction } from "@/app/(app)/marketing/lists/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(5000),
});

/**
 * Phase 21 — Bulk-add leads to a marketing list. Delegates to the
 * `bulkAddLeadsToListAction` server action so all auth, validation,
 * dedup, and audit logic lives in one place.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid body.",
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }

  const result = await bulkAddLeadsToListAction({
    listId: id,
    leadIds: parsed.data.leadIds,
  });

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
