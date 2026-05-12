/**
 * / §5.4 — canonical loading-state primitives.
 *
 * Three variants cover the most common Suspense fallback shapes:
 *
 * `table` — multi-row skeleton matching the existing list-table aesthetic
 * (border + rounded card + alternating row heights).
 * `card` — single content card placeholder for detail pages.
 * `inline`— one-line skeleton for inline async results.
 *
 * All variants render the same dashed border + animate-pulse rhythm so the
 * UI never flashes a completely empty area while waiting on Suspense data.
 */

export interface StandardLoadingStateProps {
  variant?: "table" | "card" | "inline";
  /** Row count for the `table` variant. Defaults to 5. */
  rows?: number;
  /** Accessible name for screen readers. Defaults to "Loading". */
  label?: string;
  className?: string;
}

export function StandardLoadingState({
  variant = "table",
  rows = 5,
  label = "Loading",
  className,
}: StandardLoadingStateProps) {
  if (variant === "inline") {
    return (
      <span
        role="status"
        aria-label={label}
        className={[
          "inline-block h-3 w-24 animate-pulse rounded bg-muted",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
    );
  }

  if (variant === "card") {
    return (
      <div
        role="status"
        aria-label={label}
        className={[
          "space-y-3 rounded-lg border border-border bg-card p-4",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // `table` variant
  return (
    <div
      role="status"
      aria-label={label}
      className={[
        "overflow-hidden rounded-lg border border-border bg-card",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="border-b border-border bg-muted/40 px-4 py-2.5">
        <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/5 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-3 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
