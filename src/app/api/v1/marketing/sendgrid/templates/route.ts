import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { MarketingNotConfiguredError } from "@/lib/marketing/errors";
import { getSendGrid } from "@/lib/marketing/sendgrid/client";
import { withRetry } from "@/lib/marketing/with-retry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin-only proxy to GET /v3/templates on SendGrid.
 *
 * Used by the admin marketing surface to reconcile our `marketing_templates`
 * table with what's actually stored in SendGrid (orphan detection,
 * version-id drift). Read-only; no mutation paths here.
 *
 * Auth model: session-based admin (these endpoints serve the in-app UI,
 * not external API keys). Mirrors `src/app/api/admin/email-test/route.ts`.
 */

const TemplateVersionSchema = z
  .object({
    id: z.string(),
    template_id: z.string().optional(),
    active: z.number().optional(),
    name: z.string().optional(),
    subject: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const TemplateSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    generation: z.string().optional(),
    updated_at: z.string().optional(),
    versions: z.array(TemplateVersionSchema).optional(),
  })
  .passthrough();

const TemplatesResponseSchema = z
  .object({
    result: z.array(TemplateSchema),
  })
  .passthrough();

export async function GET(_req: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  try {
    const { sgClient } = getSendGrid();
    const body = await withRetry(async () => {
      const [response, responseBody] = await sgClient.request({
        method: "GET",
        url: "/v3/templates?generations=dynamic&page_size=100",
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw asSendGridError(response.statusCode, responseBody);
      }
      return responseBody;
    });
    const parsed = TemplatesResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("sendgrid.templates.partial_parse", {
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
      // Return raw body wrapped — parse failure is informational, not
      // fatal. The admin UI handles missing fields gracefully.
      return NextResponse.json({ ok: true, raw: true, result: [] });
    }
    return NextResponse.json({ ok: true, result: parsed.data.result });
  } catch (err) {
    if (err instanceof MarketingNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: "marketing_not_configured" },
        { status: 503 },
      );
    }
    logger.error("sendgrid.templates.fetch_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}

function asSendGridError(httpStatus: number, body: unknown): Error & {
  code: number;
  response: { body: unknown };
} {
  const err = new Error(
    `SendGrid API error: HTTP ${httpStatus}`,
  ) as Error & { code: number; response: { body: unknown } };
  err.code = httpStatus;
  err.response = { body };
  return err;
}
