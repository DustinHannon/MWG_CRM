"use client";

import { RotateCw } from "lucide-react";
import { useTransition } from "react";
import { refreshServerLogsAction } from "../actions";

/**
 * Phase 26 §5 — Refresh button for /admin/server-logs.
 *
 * Invokes `refreshServerLogsAction` (server action) which calls
 * `revalidatePath('/admin/server-logs')`. That invalidates both the
 * route segment cache (page-level `revalidate = 60`) and the
 * `unstable_cache` wrapper inside `queryBetterStack`, so the next
 * render fetches fresh telemetry.
 */
export function RefreshButton() {
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      await refreshServerLogsAction();
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-label="Refresh telemetry"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground/90 transition hover:bg-muted disabled:opacity-60"
    >
      <RotateCw
        aria-hidden="true"
        className={[
          "h-3.5 w-3.5",
          isPending ? "animate-spin" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        strokeWidth={1.5}
      />
      Refresh
    </button>
  );
}
