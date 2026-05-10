import type { ReactNode } from "react";

/**
 * Phase 24 §3.4 / §5.4 — canonical page-header primitive.
 *
 * Replaces the inline H1 + description + actions row pattern at the top
 * of nearly every list and detail page. Headers stay consistent in
 * spacing, hierarchy, and the actions-row mobile collapse behaviour.
 *
 * Use `title` for the H1, `description` for the secondary line under
 * the title (e.g. record count, status, helper sentence), `actions`
 * for the trailing CTA / button cluster. On small screens the actions
 * stack below the heading via flex-wrap.
 *
 * Pages with breadcrumbs render <BreadcrumbsSetter ... /> before this
 * component; the topbar shows the trail, this component owns the body
 * heading.
 */
export interface StandardPageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Optional pill/badge cluster rendered next to the title. */
  badges?: ReactNode;
  /** Tighter top padding for detail pages embedded in a card shell. */
  variant?: "page" | "section";
  className?: string;
}

export function StandardPageHeader({
  title,
  description,
  actions,
  badges,
  variant = "page",
  className,
}: StandardPageHeaderProps) {
  const wrapperClass =
    variant === "section"
      ? "mb-3 flex flex-wrap items-start justify-between gap-3"
      : "mb-4 flex flex-wrap items-start justify-between gap-3";
  return (
    <header className={[wrapperClass, className ?? ""].filter(Boolean).join(" ")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {typeof title === "string" ? (
            <h1
              className={
                variant === "section"
                  ? "text-base font-semibold text-foreground"
                  : "text-xl font-semibold text-foreground"
              }
            >
              {title}
            </h1>
          ) : (
            title
          )}
          {badges ? (
            <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          ) : null}
        </div>
        {description ? (
          <div className="mt-1 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
