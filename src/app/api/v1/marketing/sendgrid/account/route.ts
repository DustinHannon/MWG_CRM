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
 * Phase 21 — Admin-only proxy to GET /v3/user/account on SendGrid.
 *
 * Returns the SendGrid account type (free / essentials / pro / premier)
 * + reputation score for the admin marketing surface. Used to surface
 * sender-reputation warnings before launching a campaign.
 */

const AccountSchema = z
  .object({
    type: z.string().optional(),
    reputation: z.number().optional(),
  })
  .passthrough();

export async function GET(_req: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  try {
    const { sgClient } = getSendGrid();
    const body = await withRetry(async () => {
      const [response, responseBody] = await sgClient.request({
        method: "GET",
        url: "/v3/user/account",
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw asSendGridError(response.statusCode, responseBody);
      }
      return responseBody;
    });
    const parsed = AccountSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("sendgrid.account.partial_parse", {
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
      return NextResponse.json({ ok: true, raw: true });
    }
    return NextResponse.json({ ok: true, account: parsed.data });
  } catch (err) {
    if (err instanceof MarketingNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: "marketing_not_configured" },
        { status: 503 },
      );
    }
    logger.error("sendgrid.account.fetch_failed", {
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
