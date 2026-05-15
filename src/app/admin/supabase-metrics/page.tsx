import type { Metadata } from "next";

import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { breadcrumbs } from "@/lib/navigation/breadcrumbs";
import { fetchSnapshot } from "@/lib/supabase-metrics/queries";
import type { Snapshot } from "@/lib/supabase-metrics/types";

import { SupabaseMetricsDashboard } from "./_components/dashboard";

/**
 * Supabase database monitoring dashboard.
 *
 * Admin-only — gated by `requireAdmin` (matches every sibling /admin
 * observability page; the /admin layout also enforces it). Audited
 * once per page view here on the server-side initial fetch — the
 * client poll hits the API without initial=1 so it does not re-audit.
 *
 * Initial render does a direct in-process query (no HTTP round trip);
 * the client component then polls the snapshot API every 60s. A failed
 * initial fetch is non-fatal: the client retries and the page renders.
 */

export const metadata: Metadata = {
  title: "Supabase metrics — MWG CRM admin",
};

export const dynamic = "force-dynamic";

export default async function SupabaseMetricsPage() {
  const user = await requireAdmin();

  // Once-per-view audit. Best-effort: writeAudit swallows its own
  // failures so an audit-log hiccup never blocks the page.
  await writeAudit({
    actorId: user.id,
    action: "supabase_metrics.view",
    targetType: "supabase_metrics",
    targetId: "30m",
  });

  let initial: Snapshot | null = null;
  try {
    initial = await fetchSnapshot({ range: "30m" });
  } catch (err) {
    // Non-fatal: client will retry via TanStack Query. Page still renders.
    logger.error("supabase_metrics.page.initial_fetch_failed", {
      userId: user.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={breadcrumbs.admin.supabaseMetrics()} />
      <StandardPageHeader
        kicker="Admin"
        title="Supabase metrics"
        fontFamily="display"
        description="Database CPU, memory, disk, network, Postgres, and connection-pool health. Scraped every minute; polls every 60s."
      />
      <SupabaseMetricsDashboard initialData={initial} />
    </div>
  );
}
