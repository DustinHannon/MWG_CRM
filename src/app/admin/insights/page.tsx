import { Suspense } from "react";

import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardLoadingState, StandardPageHeader } from "@/components/standard";
import { requireAdmin } from "@/lib/auth-helpers";
import { breadcrumbs } from "@/lib/navigation/breadcrumbs";

import { CoreWebVitals } from "./_components/core-web-vitals";
import { IssuesBanner } from "./_components/issues-banner";
import { KpiCards } from "./_components/kpi-cards";
import { RecentDeployments } from "./_components/recent-deployments";
import { RefreshButton } from "./_components/refresh-button";
import { TopPagesTable } from "./_components/top-pages-table";
import { TopReferrersTable } from "./_components/top-referrers-table";
import { TrafficTimeline } from "./_components/traffic-timeline";
import { WorldMapPanel } from "./_components/world-map-panel";

/**
 * Admin Insights dashboard.
 *
 * Server component. Each panel is its own async component wrapped in
 * `<Suspense>` so a slow Better Stack query never blocks the whole
 * page — the rest of the panels stream in. The 60s `revalidate`
 * (mirrored by the `unstable_cache` wrappers on `queryBetterStack`
 * and `listRecentDeployments`) keeps each render cheap; the
 * `RefreshButton` calls `revalidatePath` to bypass on demand.
 *
 * Permission: requireAdmin (matches every other /admin page).
 */
export const revalidate = 60;
export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  await requireAdmin();

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={breadcrumbs.admin.insights()} />
      <StandardPageHeader
        kicker="Admin"
        title="Platform Insights"
        fontFamily="display"
        description="Real-time view of platform health, traffic, and deployments. Data is cached for 60 seconds; click Refresh to pull fresh metrics."
        actions={<RefreshButton />}
      />

      <div className="mt-8 space-y-8">
        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <IssuesBanner />
        </Suspense>

        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <KpiCards />
        </Suspense>

        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <TrafficTimeline />
        </Suspense>

        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <CoreWebVitals />
        </Suspense>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Suspense fallback={<StandardLoadingState variant="table" />}>
            <TopPagesTable />
          </Suspense>
          <Suspense fallback={<StandardLoadingState variant="table" />}>
            <TopReferrersTable />
          </Suspense>
        </div>

        <Suspense fallback={<StandardLoadingState variant="card" />}>
          <WorldMapPanel />
        </Suspense>

        <Suspense fallback={<StandardLoadingState variant="table" />}>
          <RecentDeployments />
        </Suspense>
      </div>
    </div>
  );
}
