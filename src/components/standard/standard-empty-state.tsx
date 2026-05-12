import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * / §5.4 — canonical empty-state primitive.
 * added `variant?: "card" | "muted"` to cover the
 * inline `bg-muted/40` single-line empty pattern used by tasks,
 * leads detail tabs, and similar dense surfaces.
 *
 * Replaces the duplicated inline pattern across leads/contacts/accounts/
 * marketing-* list pages:
 *
 * <div className="flex h-48 flex-col items-center justify-center gap-2
 * rounded-lg border border-dashed border-border bg-card
 * text-center">
 * <p className="text-sm font-medium text-foreground">No X yet</p>
 * <p className="text-xs text-muted-foreground">Helper copy</p>
 * </div>
 *
 * Use `icon` (optional lucide-react component) for a visual anchor; pass
 * `action` (already-styled CTA) when the empty state should suggest a
 * next step like "New template". The size variants `compact` / `default`
 * cover inline-row empty states and full-section ones respectively.
 *
 * `variant="muted"` renders the dense `bg-muted/40` single-line empty
 * state used on detail-page list tabs.
 */
export interface StandardEmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  /** `compact` ≈ inline row replacement; `default` ≈ full-section placeholder. */
  size?: "compact" | "default";
  /**
   * Visual treatment:
   * `card` (default): dashed border, `bg-card`, centered title + description.
   * `muted` : solid rounded `bg-muted/40` row, no dashed border.
   * Matches the inline empty patterns on detail tabs.
   */
  variant?: "card" | "muted";
  /** Optional extra classes for callers that need to widen / narrow. */
  className?: string;
}

export function StandardEmptyState({
  title,
  description,
  icon: Icon,
  action,
  size = "default",
  variant = "card",
  className,
}: StandardEmptyStateProps) {
  if (variant === "muted") {
    return (
      <div
        role="status"
        className={[
          "rounded-md bg-muted/40 px-4 py-3 text-sm text-muted-foreground",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="flex flex-wrap items-center gap-2">
          {Icon ? (
            <Icon
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
              strokeWidth={1.5}
            />
          ) : null}
          <span className="font-medium text-foreground">{title}</span>
          {description ? (
            <span className="text-muted-foreground">{description}</span>
          ) : null}
          {action ? <span className="ml-auto">{action}</span> : null}
        </div>
      </div>
    );
  }
  const sizeClass =
    size === "compact"
      ? "min-h-24 gap-1.5 px-4 py-4"
      : "h-48 gap-2 px-4 py-6";
  return (
    <div
      role="status"
      className={[
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card text-center",
        sizeClass,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="h-5 w-5 text-muted-foreground"
          strokeWidth={1.5}
        />
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
