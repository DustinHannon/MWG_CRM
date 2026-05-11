import { PieChart as PieIcon } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import {
  getStatusDistribution,
  type ServerLogsRange,
} from "@/lib/observability/server-logs-queries";
import {
  BetterStackNotConfiguredError,
  isBetterStackConfigured,
} from "@/lib/observability/betterstack";
import { StatusDistributionChart } from "./status-distribution-chart";

/**
 * Phase 26 §5 — Panel 3: status code distribution (donut chart).
 *
 * Buckets every proxy status into 2xx/3xx/4xx/5xx. Renders as a
 * recharts PieChart with the standard `var(--chart-1..4)` palette
 * (matches reports / dashboard tooling for visual consistency).
 *
 * The server component does the query; the donut itself is a client
 * sub-component (recharts requires DOM access).
 */

export interface StatusDistributionPanelProps {
  range: ServerLogsRange;
}

export async function StatusDistributionPanel({
  range,
}: StatusDistributionPanelProps) {
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

  let rows: Awaited<ReturnType<typeof getStatusDistribution>>;
  try {
    rows = await getStatusDistribution(range);
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
          title="No traffic in this window"
          description="No HTTP responses recorded by the drain."
        />
      </PanelShell>
    );
  }

  const data = rows.map((r) => ({
    bucket: r.bucket,
    count: Number(r.n ?? 0),
  }));

  return (
    <PanelShell>
      <div className="rounded-lg border border-border bg-card p-4">
        <StatusDistributionChart data={data} />
      </div>
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <StandardPageHeader
        variant="section"
        title={
          <span className="inline-flex items-center gap-2">
            <PieIcon
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            Status distribution
          </span>
        }
        description="Share of proxy responses by HTTP status bucket."
      />
      {children}
    </section>
  );
}
