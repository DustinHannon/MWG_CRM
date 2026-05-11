import type { ReactNode } from "react";

/**
 * Phase 24 §3.4 / §5.4 — canonical page-header primitive.
 * Phase 26 D3.1 — upgraded defaults to match the codebase baseline:
 *   - h1: text-2xl font-semibold (was text-xl)
 *   - subtitle: text-sm (was text-xs)
 *   - kicker?: optional `text-[10px] uppercase tracking-[0.3em]` label
 *   - fontFamily?: "default" | "display" — applies font-display serif
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
  /**
   * Optional uppercase eyebrow label rendered above the h1 — mirrors
   * the `text-[10px] uppercase tracking-[0.3em] text-muted-foreground`
   * pattern used on /accounts, /contacts, /opportunities, etc.
   */
  kicker?: string;
  /**
   * Apply the serif `font-display` family to the h1 (matches /accounts,
   * /contacts, /leads/pipeline, /opportunities/pipeline, etc.).
   * Defaults to "default" (system sans).
   */
  fontFamily?: "default" | "display";
  /** Tighter top padding for detail pages embedded in a card shell. */
  variant?: "page" | "section";
  className?: string;
}

export function StandardPageHeader({
  title,
  description,
  actions,
  badges,
  kicker,
  fontFamily = "default",
  variant = "page",
  className,
}: StandardPageHeaderProps) {
  const wrapperClass =
    variant === "section"
      ? "mb-3 flex flex-wrap items-start justify-between gap-3"
      : "mb-4 flex flex-wrap items-start justify-between gap-3";
  const h1Class =
    variant === "section"
      ? "text-base font-semibold text-foreground"
      : [
          "text-2xl font-semibold text-foreground",
          fontFamily === "display" ? "font-display" : "",
        ]
          .filter(Boolean)
          .join(" ");
  return (
    <header className={[wrapperClass, className ?? ""].filter(Boolean).join(" ")}>
      <div className="min-w-0 flex-1">
        {kicker ? (
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            {kicker}
          </p>
        ) : null}
        <div
          className={[
            "flex flex-wrap items-center gap-2",
            kicker ? "mt-1" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {typeof title === "string" ? (
            <h1 className={h1Class}>{title}</h1>
          ) : (
            title
          )}
          {badges ? (
            <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          ) : null}
        </div>
        {description ? (
          <div className="mt-1 text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
