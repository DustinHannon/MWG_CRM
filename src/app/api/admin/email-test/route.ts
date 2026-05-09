import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-helpers";
import { sendEmailAs } from "@/lib/email";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(255),
  body: z.string().min(1).max(50_000),
});

/**
 * Phase 15 — admin-only diagnostic that exercises sendEmailAs end-to-end.
 * Useful for smoke testing the Graph token + preflight + send pipeline
 * without coupling to a real product surface (reports, notifications, etc.).
 *
 * Subject the standard E2E sentinel `[E2E-…]` to skip actual delivery.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin();
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await sendEmailAs({
    fromUserId: admin.id,
    to: [{ email: parsed.data.to }],
    subject: parsed.data.subject,
    html: `<p>${escapeHtml(parsed.data.body)}</p>`,
    feature: "admin.email_test",
    metadata: { source: "/api/admin/email-test" },
  });

  return NextResponse.json(result);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
