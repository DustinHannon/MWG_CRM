"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Info, TriangleAlert } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils";
import {
  useRunRealtime,
  type RunCounters,
  type RunLogEntry,
  type RunRealtimeStatus,
  type RunSnapshot,
} from "./use-run-realtime";

/**
 * Sticky live-progress panel for the run detail page.
 *
 * Subscribes to `d365-import-run:<runId>` Realtime broadcasts via
 * `useRunRealtime`. Falls back to 5-second polling on Realtime
 * failure (no Supabase env, channel error, etc.).
 *
 * Layout (top→bottom):
 * 1. Status pill + halt-reason chip (if paused)
 * 2. Current operation text (e.g. "Mapping batch #3 — 42/100")
 * 3. 7-counter records row
 * (fetched / mapped / approved / rejected / committed / skipped / failed)
 * 4. Log scroll (last 10, expand to detail; errors persist until dismissed)
 *
 * Server passes the initial snapshot (from DB) so the panel renders
 * instantly; Realtime takes over for subsequent updates.
 */

interface RunLiveProgressProps {
  runId: string;
  initialStatus: RunRealtimeStatus;
  initialCurrentOperation?: string | null;
  initialCounters?: Partial<RunCounters>;
  initialLogs?: RunLogEntry[];
  initialHaltReason?: string | null;
}

const ZERO_COUNTERS: RunCounters = {
  fetched: 0,
  mapped: 0,
  approved: 0,
  rejected: 0,
  committed: 0,
  skipped: 0,
  failed: 0,
};

const STATUS_LABEL: Record<RunRealtimeStatus, string> = {
  created: "Created",
  fetching: "Fetching",
  mapping: "Mapping",
  reviewing: "Reviewing",
  committing: "Committing",
  paused_for_review: "Paused — awaiting review",
  completed: "Completed",
  aborted: "Aborted",
};

const STATUS_VARIANT: Record<RunRealtimeStatus, string> = {
  created: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
  fetching: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  mapping: "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
  reviewing:
    "bg-[var(--status-qualification-bg)] text-[var(--status-qualification-fg)]",
  committing:
    "bg-[var(--status-negotiation-bg)] text-[var(--status-negotiation-fg)]",
  paused_for_review: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  completed: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  aborted: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
};

export function RunLiveProgress({
  runId,
  initialStatus,
  initialCurrentOperation = null,
  initialCounters,
  initialLogs = [],
  initialHaltReason = null,
}: RunLiveProgressProps) {
  const initial: RunSnapshot = {
    status: initialStatus,
    currentOperation: initialCurrentOperation,
    counters: { ...ZERO_COUNTERS, ...(initialCounters ?? {}) },
    logs: initialLogs,
    haltReason: initialHaltReason,
  };
  const snapshot = useRunRealtime({ runId, initial });

  return (
    <GlassCard className="sticky top-4 z-10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium leading-tight",
            STATUS_VARIANT[snapshot.status],
          )}
        >
          {STATUS_LABEL[snapshot.status]}
        </span>
        {snapshot.haltReason ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--status-lost-bg)]/60 px-2 py-0.5 text-[11px] font-medium text-[var(--status-lost-fg)]">
            <TriangleAlert className="h-3 w-3" />
            {snapshot.haltReason.replace(/_/g, " ")}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Live
        </span>
      </div>

      <p className="mt-3 text-sm text-foreground">
        {snapshot.currentOperation ??
          "No active operation — pull the next batch when ready."}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Counter label="Fetched" value={snapshot.counters.fetched} />
        <Counter label="Mapped" value={snapshot.counters.mapped} />
        <Counter label="Approved" value={snapshot.counters.approved} />
        <Counter label="Rejected" value={snapshot.counters.rejected} />
        <Counter label="Committed" value={snapshot.counters.committed} />
        <Counter label="Skipped" value={snapshot.counters.skipped} />
        <Counter
          label="Failed"
          value={snapshot.counters.failed}
          tone={snapshot.counters.failed > 0 ? "warn" : "neutral"}
        />
      </div>

      <LogList logs={snapshot.logs} />
    </GlassCard>
  );
}

function Counter({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-semibold",
          tone === "warn" ? "text-destructive" : "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function LogList({ logs }: { logs: RunLogEntry[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (logs.length === 0) {
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        No log entries yet. Activity will appear here as batches process.
      </p>
    );
  }

  const recent = logs.slice(0, 10);
  return (
    <ul className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/30 p-2">
      {recent.map((log) => {
        const isOpen = expanded.has(log.id);
        const Icon =
          log.level === "error"
            ? AlertCircle
            : log.level === "warn"
              ? TriangleAlert
              : Info;
        const tone =
          log.level === "error"
            ? "text-destructive"
            : log.level === "warn"
              ? "text-[var(--status-proposal-fg)]"
              : "text-muted-foreground";
        return (
          <li key={log.id} className="text-xs">
            <button
              type="button"
              onClick={() => log.detail && toggle(log.id)}
              className={cn(
                "flex w-full items-start gap-2 rounded px-1 py-0.5 text-left",
                log.detail
                  ? "hover:bg-muted/60"
                  : "cursor-default",
              )}
            >
              <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", tone)} />
              <span className="grow text-foreground">{log.message}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {formatTime(log.at)}
              </span>
              {log.detail ? (
                isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )
              ) : null}
            </button>
            {isOpen && log.detail ? (
              <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1 text-[10px] text-muted-foreground">
                {log.detail}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
