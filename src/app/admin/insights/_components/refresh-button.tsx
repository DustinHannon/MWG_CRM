"use client";

import { RotateCw } from "lucide-react";
import { useTransition } from "react";

import { refreshInsightsAction } from "../actions";

/**
 * Insights page refresh button.
 *
 * Calls a server action that runs `revalidatePath('/admin/insights')`,
 * which invalidates both the page-level cache and the
 * `unstable_cache` wrappers used by `queryBetterStack` /
 * `listRecentDeployments`. Reduces the 60-second TTL to "now" without
 * forcing a hard page reload.
 */
export function RefreshButton() {
  const [pending, start] = useTransition();
  return (
    <form action={() => start(() => refreshInsightsAction())}>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
      >
        <RotateCw
          aria-hidden="true"
          className={[
            "h-3.5 w-3.5",
            pending ? "animate-spin" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          strokeWidth={1.5}
        />
        {pending ? "Refreshing…" : "Refresh"}
      </button>
    </form>
  );
}
