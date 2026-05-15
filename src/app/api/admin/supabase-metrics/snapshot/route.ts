import { NextResponse } from "next/server";

import { writeAudit } from "@/lib/audit";
import { withInternalListApi } from "@/lib/api/internal-list";
import { logger } from "@/lib/logger";
import { fetchSnapshot } from "@/lib/supabase-metrics/queries";
import { parseRange, type Snapshot } from "@/lib/supabase-metrics/types";

/**
 * GET /api/admin/supabase-metrics/snapshot?range=30m&initial=1
 *
 * Single round-trip returning the current scrape + bucketed history.
 * Admin-gated through `withInternalListApi({ auth: "admin" })`.
 *
 * Audit emission:
 *   The dashboard polls every 60s via TanStack Query. Emitting an
 *   audit row per poll would noise up the log; we only audit when the
 *   server component issues the *initial* fetch (`initial=1`). The
 *   polling endpoint reads the same payload but does not audit.
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

      const isInitial = url.searchParams.get("initial") === "1";

      const snapshot: Snapshot = await fetchSnapshot({ range });

      const durationMs = Date.now() - startedAt;
      if (durationMs > 3000) {
        logger.warn("supabase_metrics.snapshot.query_slow", {
          durationMs,
          range,
          userId: user.id,
        });
      }

      if (isInitial) {
        await writeAudit({
          actorId: user.id,
          action: "supabase_metrics.view",
          targetType: "supabase_metrics",
          targetId: range,
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
