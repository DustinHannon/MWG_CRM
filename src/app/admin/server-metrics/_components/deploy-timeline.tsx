import { Timer } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import { getDeployTimeline } from "@/lib/observability/server-metrics-queries";
import {
  BetterStackNotConfiguredError,
  isBetterStackConfigured,
} from "@/lib/observability/betterstack";
import {
  isVercelApiConfigured,
  listRecentDeployments,
} from "@/lib/observability/vercel-api";
import {
  DeployTimelineChart,
  type DeployMarker,
  type DeployTimelinePoint,
} from "./deploy-timeline-chart";

/**
 * Panel 5: deploy timeline.
 *
 * Aggregates errors per 5-minute bucket over the last 24 hours and
 * overlays vertical reference lines for each recent Vercel deployment.
 * Always 24h regardless of the page-level range so the operator can
 * correlate spikes with the most recent deploy(s) without changing
 * the rest of the page.
 *
 * Vercel deployment markers are optional — if the Vercel API isn't
 * configured we render just the error-rate line.
 */

export async function DeployTimelinePanel() {
  if (!isBetterStackConfigured()) {
    return (
      <PanelShell>
        <StandardEmptyState
          variant="muted"
          title="Better Stack not configured"
          description="Set BETTERSTACK_* env vars and rebuild to populate this panel."
        />
      </PanelShell>
    );
  }

  let rows: Awaited<ReturnType<typeof getDeployTimeline>>;
  try {
    rows = await getDeployTimeline();
  } catch (err) {
    if (err instanceof BetterStackNotConfiguredError) {
      return (
        <PanelShell>
          <StandardEmptyState
            variant="muted"
            title="Better Stack not configured"
            description="Set BETTERSTACK_* env vars and rebuild to populate this panel."
          />
        </PanelShell>
      );
    }
    return (
      <PanelShell>
        <StandardEmptyState
          variant="muted"
          title="Query failed"
          description={(err as Error).message}
        />
      </PanelShell>
    );
  }

  if (rows.length === 0) {
    return (
      <PanelShell>
        <StandardEmptyState
          title="No traffic in the last 24h"
          description="Drain produced no rows for the window."
        />
      </PanelShell>
    );
  }

  const points: DeployTimelinePoint[] = rows.map((r) => {
    const total = Number(r.total ?? 0);
    const errors = Number(r.errors ?? 0);
    const ts = new Date(r.bucket).getTime();
    return {
      ts,
      label: new Date(r.bucket).toISOString(),
      total,
      errors,
      // Error rate as a percentage; guard against divide-by-zero.
      rate: total > 0 ? (errors / total) * 100 : 0,
    };
  });

  // Best-effort fetch deploy markers. Failures here should never block
  // the panel — the chart is still useful without them.
  const markers = await loadDeployMarkers();

  return (
    <PanelShell>
      <div className="rounded-lg border border-border bg-card p-4">
        <DeployTimelineChart points={points} markers={markers} />
      </div>
    </PanelShell>
  );
}

/**
 * Pulled out of the component body so the eslint `react-hooks/purity`
 * rule (which flags `Date.now()` inside a function React might treat
 * as a component) doesn't trigger. Server-side I/O + clock reads
 * belong in a plain helper, not inline in the render tree.
 */
async function loadDeployMarkers(): Promise<DeployMarker[]> {
  if (!isVercelApiConfigured()) return [];
  try {
    const deployments = await listRecentDeployments({ limit: 10 });
    const windowStart = Date.now() - 24 * 60 * 60 * 1000;
    return deployments
      .filter((d) => d.state === "READY" && d.ready && d.ready >= windowStart)
      .map((d) => ({
        ts: d.ready!,
        sha: d.meta?.githubCommitSha?.slice(0, 7) ?? null,
        ref: d.meta?.githubCommitRef ?? null,
      }));
  } catch {
    // Silent — markers are decorative. The audit hook inside
    // `listRecentDeployments` already records the failure.
    return [];
  }
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <StandardPageHeader
        variant="section"
        title={
          <span className="inline-flex items-center gap-2">
            <Timer
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            Deploy timeline
          </span>
        }
        description="Error rate per 5-minute bucket (last 24h). Vertical lines mark Vercel deployments."
      />
      {children}
    </section>
  );
}
