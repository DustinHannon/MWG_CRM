import { Activity } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import {
  getRequestVolume,
  type ServerLogsRange,
} from "@/lib/observability/server-logs-queries";
import {
  BetterStackNotConfiguredError,
  isBetterStackConfigured,
} from "@/lib/observability/betterstack";

/**
 * Panel 2: top 20 endpoints by request count.
 *
 * The query excludes `/_next/*` and `/favicon*` so static-asset noise
 * doesn't dominate. Each row shows total requests, 5xx error count,
 * and the computed error rate. The error-rate cell is tinted at the
 * destructive token when ≥1%, mirroring the email-failures admin page
 * approach (semantic color, not raw red).
 */

export interface RequestVolumePanelProps {
  range: ServerLogsRange;
}

export async function RequestVolumePanel({ range }: RequestVolumePanelProps) {
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

  let rows: Awaited<ReturnType<typeof getRequestVolume>>;
  try {
    rows = await getRequestVolume(range);
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
          title="No requests in this window"
          description="Either no traffic reached the app or the drain hasn't caught up."
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Path</th>
              <th className="px-4 py-2.5 font-medium tabular-nums">Requests</th>
              <th className="px-4 py-2.5 font-medium tabular-nums">5xx</th>
              <th className="px-4 py-2.5 font-medium tabular-nums">Error rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, i) => {
              const requests = Number(row.requests ?? 0);
              const errors = Number(row.errors ?? 0);
              const rate = requests > 0 ? errors / requests : 0;
              const highError = rate >= 0.01;
              return (
                <tr key={`${row.path ?? "null"}-${i}`}>
                  <td className="px-4 py-3">
                    <div className="max-w-xl truncate font-mono text-[11px] text-foreground/90">
                      {row.path ?? "(null)"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-foreground/90">
                    {requests.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-muted-foreground">
                    {errors.toLocaleString()}
                  </td>
                  <td
                    className={[
                      "px-4 py-3 text-xs tabular-nums",
                      highError ? "text-destructive" : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {(rate * 100).toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
            <Activity
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            Request volume
          </span>
        }
        description="Top 20 endpoints by request count. Static-asset paths excluded."
      />
      {children}
    </section>
  );
}
