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
 * Phase 21 — Admin-only proxy to GET /v3/stats on SendGrid.
 *
 * Returns daily aggregate stats (delivered / opens / clicks / bounces /
 * unsubscribes / spam_reports) for the most recent N days (default 30,
 * max 90). Used by the admin marketing dashboard for an at-a-glance
 * health view independent of our own per-campaign counters.
 */

const StatMetricsSchema = z
  .object({
    blocks: z.number().optional(),
    bounce_drops: z.number().optional(),
    bounces: z.number().optional(),
    clicks: z.number().optional(),
    deferred: z.number().optional(),
    delivered: z.number().optional(),
    invalid_emails: z.number().optional(),
    opens: z.number().optional(),
    processed: z.number().optional(),
    requests: z.number().optional(),
    spam_report_drops: z.number().optional(),
    spam_reports: z.number().optional(),
    unique_clicks: z.number().optional(),
    unique_opens: z.number().optional(),
    unsubscribe_drops: z.number().optional(),
    unsubscribes: z.number().optional(),
  })
  .passthrough();

const StatEntrySchema = z
  .object({
    date: z.string(),
    stats: z
      .array(
        z
          .object({
            metrics: StatMetricsSchema,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const StatsResponseSchema = z.array(StatEntrySchema);

export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  const url = new URL(req.url);
  const daysParam = Number.parseInt(
    url.searchParams.get("days") ?? "30",
    10,
  );
  const days = Number.isFinite(daysParam)
    ? Math.max(1, Math.min(daysParam, 90))
    : 30;

  const today = new Date();
  const startDate = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  const startIso = isoDate(startDate);
  const endIso = isoDate(today);

  try {
    const { sgClient } = getSendGrid();
    const body = await withRetry(async () => {
      const [response, responseBody] = await sgClient.request({
        method: "GET",
        url: `/v3/stats?start_date=${encodeURIComponent(startIso)}&end_date=${encodeURIComponent(endIso)}&aggregated_by=day`,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw asSendGridError(response.statusCode, responseBody);
      }
      return responseBody;
    });
    const parsed = StatsResponseSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("sendgrid.stats.partial_parse", {
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
      return NextResponse.json({
        ok: true,
        raw: true,
        startDate: startIso,
        endDate: endIso,
        days,
        result: [],
      });
    }
    return NextResponse.json({
      ok: true,
      startDate: startIso,
      endDate: endIso,
      days,
      result: parsed.data,
    });
  } catch (err) {
    if (err instanceof MarketingNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: "marketing_not_configured" },
        { status: 503 },
      );
    }
    logger.error("sendgrid.stats.fetch_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: "Internal error" },
      { status: 500 },
    );
  }
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
