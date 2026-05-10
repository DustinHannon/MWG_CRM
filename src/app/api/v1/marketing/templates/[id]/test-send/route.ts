import { NextResponse } from "next/server";
import { z } from "zod";
import { sendTestTemplateAction } from "@/app/(app)/marketing/templates/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 21 — Test-send a template to an arbitrary recipient. Wraps
 * the server action so audit, rate limiting, and permissions all
 * flow through the same code path as the in-page UI button.
 */

const idSchema = z.string().uuid();
const bodySchema = z.object({
  recipientEmail: z.string().email(),
});

export async function POST(
  req: Request,
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "recipientEmail must be a valid email address." },
      { status: 400 },
    );
  }

  const result = await sendTestTemplateAction({
    id: idCheck.data,
    recipientEmail: parsed.data.recipientEmail,
  });
  if (!result.ok) {
    const status =
      result.code === "FORBIDDEN"
        ? 403
        : result.code === "NOT_FOUND"
          ? 404
          : result.code === "RATE_LIMIT"
            ? 429
            : result.code === "VALIDATION"
              ? 422
              : 500;
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status },
    );
  }
  return NextResponse.json({ ok: true, messageId: result.data.messageId });
}
