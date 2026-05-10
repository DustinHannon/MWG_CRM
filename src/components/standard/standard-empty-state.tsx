import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Phase 24 §3.4 / §5.4 — canonical empty-state primitive.
 *
 * Replaces the duplicated inline pattern across leads/contacts/accounts/
 * marketing-* list pages:
 *
 *   <div className="flex h-48 flex-col items-center justify-center gap-2
 *                   rounded-lg border border-dashed border-border bg-card
 *                   text-center">
 *     <p className="text-sm font-medium text-foreground">No X yet</p>
 *     <p className="text-xs text-muted-foreground">Helper copy</p>
 *   </div>
 *
 * Use `icon` (optional lucide-react component) for a visual anchor; pass
 * `action` (already-styled CTA) when the empty state should suggest a
 * next step like "New template". The size variants `compact` / `default`
 * cover inline-row empty states and full-section ones respectively.
 */
export interface StandardEmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  /** `compact` ≈ inline row replacement; `default` ≈ full-section placeholder. */
  size?: "compact" | "default";
  /** Optional extra classes for callers that need to widen / narrow. */
  className?: string;
}

export function StandardEmptyState({
  title,
  description,
  icon: Icon,
  action,
  size = "default",
  className,
}: StandardEmptyStateProps) {
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
