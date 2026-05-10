import { NextResponse } from "next/server";
import { z } from "zod";
import { forceUnlockTemplateAction } from "@/app/(app)/marketing/templates/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — Admin-only "force unlock" endpoint. Delegates to the
 * server action so the audit row, permission check, and revalidate
 * paths flow through the same code path as the in-page button.
 */

const idSchema = z.string().uuid();

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const idCheck = idSchema.safeParse(id);
  if (!idCheck.success) {
    return NextResponse.json(
      { error: "Invalid template id." },
      { status: 400 },
    );
  }

  const result = await forceUnlockTemplateAction(idCheck.data);
  if (!result.ok) {
    const status =
      result.code === "FORBIDDEN"
        ? 403
        : result.code === "NOT_FOUND"
          ? 404
          : result.code === "VALIDATION"
            ? 400
            : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
