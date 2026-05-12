import { Suspense } from "react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import {
  StandardLoadingState,
  StandardPageHeader,
} from "@/components/standard";
import { requireAdmin } from "@/lib/auth-helpers";
import { breadcrumbs } from "@/lib/navigation/breadcrumbs";
import type { ServerLogsRange } from "@/lib/observability/server-logs-queries";
import { ErrorPatternsPanel } from "./_components/error-patterns";
import { RequestVolumePanel } from "./_components/request-volume";
import { StatusDistributionPanel } from "./_components/status-distribution";
import { SlowEndpointsPanel } from "./_components/slow-endpoints";
import { DeployTimelinePanel } from "./_components/deploy-timeline";
import { TimeRangeSelector } from "./_components/time-range-selector";
import { RefreshButton } from "./_components/refresh-button";

/**
 * /admin/server-logs.
 *
 * Aggregated telemetry from production Vercel runtime logs. NOT a raw
 * log tail — every panel renders a grouped/derived view (top error
 * patterns, top endpoints, status distribution, deploy timeline).
 *
 * Caching:
 * Page-level `revalidate = 60` (segment ISR window).
 * Each Better Stack query is wrapped in `unstable_cache` with the
 * same TTL inside `queryBetterStack`.
 * The Refresh button calls a server action that invokes
 * `revalidatePath` to bust both layers on demand.
 *
 * Admin-only — gate via `requireAdmin` which redirects non-admins to
 * the dashboard.
 */

export const revalidate = 60;

const VALID_RANGES = ["1h", "6h", "24h", "7d"] as const;

function parseRange(input: string | undefined): ServerLogsRange {
  if (input && (VALID_RANGES as readonly string[]).includes(input)) {
    return input as ServerLogsRange;
  }
  return "1h";
}

export default async function ServerLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const range = parseRange(sp.range);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={breadcrumbs.admin.serverLogs()} />

      <StandardPageHeader
        kicker="Admin"
        title="Server logs"
        description="Aggregated telemetry from production runtime logs."
        fontFamily="display"
        actions={
          <div className="flex items-center gap-2">
            <TimeRangeSelector currentRange={range} />
            <RefreshButton />
          </div>
        }
      />

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Each panel is wrapped in its own Suspense so the slowest
            query doesn't block the rest of the page from streaming.
            Panel order pairs ErrorPatterns with StatusDistribution
            (both moderate-height) on row 1; RequestVolume (20-row
            table) pairs with SlowEndpoints on row 2. */}
        <Suspense
          fallback={<StandardLoadingState variant="table" rows={5} />}
          key={`error-patterns-${range}`}
        >
          <ErrorPatternsPanel range={range} />
        </Suspense>

        <Suspense
          fallback={<StandardLoadingState variant="card" />}
          key={`status-distribution-${range}`}
        >
          <StatusDistributionPanel range={range} />
        </Suspense>

        <Suspense
          fallback={<StandardLoadingState variant="table" rows={5} />}
          key={`request-volume-${range}`}
        >
          <RequestVolumePanel range={range} />
        </Suspense>

        <Suspense
          fallback={<StandardLoadingState variant="table" rows={5} />}
          key={`slow-endpoints-${range}`}
        >
          <SlowEndpointsPanel range={range} />
        </Suspense>
      </div>

      <div className="mt-8">
        {/* Deploy timeline is intentionally always 24h, so it's not
            keyed on the range — but we still wrap in Suspense so the
            chart streams in independently from the panels above. */}
        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <DeployTimelinePanel />
        </Suspense>
      </div>
    </div>
  );
}
