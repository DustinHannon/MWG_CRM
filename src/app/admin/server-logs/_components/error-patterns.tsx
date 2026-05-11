import { AlertTriangle } from "lucide-react";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import { UserTime } from "@/components/ui/user-time";
import {
  getErrorPatterns,
  type ServerLogsRange,
} from "@/lib/observability/server-logs-queries";
import {
  BetterStackNotConfiguredError,
  isBetterStackConfigured,
} from "@/lib/observability/betterstack";

/**
 * Phase 26 §5 — Panel 1: top 10 error patterns.
 *
 * Renders rows grouped by Better Stack's auto-pattern field for log
 * lines with HTTP status >= 500. Each row shows the pattern (monospace,
 * truncated), count, first/last seen, and an expandable sample message.
 *
 * NOT a raw log tail — at most 10 patterns rendered, each one
 * representing potentially hundreds of correlated lines.
 */

export interface ErrorPatternsPanelProps {
  range: ServerLogsRange;
}

export async function ErrorPatternsPanel({ range }: ErrorPatternsPanelProps) {
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

  let rows: Awaited<ReturnType<typeof getErrorPatterns>>;
  try {
    rows = await getErrorPatterns(range);
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
          title="No 5xx errors in this window"
          description="Nothing to group — every request returned 4xx or better."
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
              <th className="px-4 py-2.5 font-medium">Pattern</th>
              <th className="px-4 py-2.5 font-medium tabular-nums">Count</th>
              <th className="px-4 py-2.5 font-medium">First seen</th>
              <th className="px-4 py-2.5 font-medium">Last seen</th>
              <th className="px-4 py-2.5 font-medium">Sample</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, i) => {
              const count = Number(row.n ?? 0);
              const pattern = row.pattern ?? "(empty)";
              return (
                <tr key={`${pattern}-${i}`} className="align-top">
                  <td className="px-4 py-3">
                    <div className="line-clamp-2 max-w-xl font-mono text-[11px] text-foreground/90">
                      {pattern}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-foreground/90">
                    {count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.first_seen ? (
                      <UserTime value={new Date(row.first_seen)} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.last_seen ? (
                      <UserTime value={new Date(row.last_seen)} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.sample ? (
                      <details>
                        <summary className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline">
                          view
                        </summary>
                        <pre className="mt-2 max-w-md overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[10px] text-foreground/90">
                          {row.sample}
                        </pre>
                      </details>
                    ) : (
                      "—"
                    )}
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
            <AlertTriangle
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
            Error patterns
          </span>
        }
        description="Top 10 recurring 5xx patterns. Grouped by Better Stack's auto-pattern field (dynamic IDs stripped)."
      />
      {children}
    </section>
  );
}
