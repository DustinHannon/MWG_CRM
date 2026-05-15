import { NextResponse } from "next/server";

import { withInternalListApi } from "@/lib/api/internal-list";
import { logger } from "@/lib/logger";
import { fetchSnapshot } from "@/lib/supabase-metrics/queries";
import { parseRange, type Snapshot } from "@/lib/supabase-metrics/types";

/**
 * GET /api/admin/supabase-metrics/snapshot?range=30m
 *
 * Single round-trip returning the current scrape + bucketed history.
 * Admin-gated through `withInternalListApi({ auth: "admin" })`.
 *
 * Audit emission:
 *   This polling endpoint does not audit. The dashboard polls every
 *   60s via TanStack Query, so a per-request audit row would only add
 *   noise. The once-per-view audit is emitted by the server component
 *   that renders the page, not by this endpoint.
 *
 * Degraded response:
 *   On any internal error we log `supabase_metrics.snapshot.degraded`
 *   and return HTTP 200 with `{ asOf: null, current: null, history:
 *   null, meta: { error: "transient" } }`. The UI handles the null
 *   payload as an empty state; the page itself never breaks.
 */

export const GET = withInternalListApi(
  { action: "admin.supabase_metrics.snapshot", auth: "admin" },
  async (req, { user }) => {
    const startedAt = Date.now();
    try {
      const url = new URL(req.url);
      const rawRange = url.searchParams.get("range") ?? "30m";
      const range = parseRange(rawRange);
      if (!range) {
        return NextResponse.json({ error: "Invalid range" }, { status: 400 });
      }

      const snapshot: Snapshot = await fetchSnapshot({ range });

      const durationMs = Date.now() - startedAt;
      if (durationMs > 3000) {
        logger.warn("supabase_metrics.snapshot.query_slow", {
          durationMs,
          range,
          userId: user.id,
        });
      }

      return NextResponse.json(snapshot);
    } catch (err) {
      logger.error("supabase_metrics.snapshot.degraded", {
        durationMs: Date.now() - startedAt,
        userId: user.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Degraded payload — client renders empty state, not a broken page.
      const degraded: Snapshot = {
        asOf: null,
        current: null,
        history: null,
        meta: {
          rangeMs: 0,
          pointCount: 0,
          lastScrapeAt: null,
          scrapeGaps: 0,
          error: "transient",
        },
      };
      return NextResponse.json(degraded);
    }
  },
);
