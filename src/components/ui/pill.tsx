import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical pill base. The single source of truth for the small
 * rounded status/priority/verb chip used across list pages, detail
 * headers, and admin tables. Per-concept pills (StatusPill,
 * PriorityPill, ActivityPill, RunStatusPill) own their value→token
 * (`--status-*` / `--priority-*`) and value→label maps and the
 * unknown-value diagnostic, then delegate the markup here so the box
 * model / typography / theme contrast stays identical everywhere and
 * changes in one place.
 *
 * `variant` is the paired bg/fg token classes
 * (`bg-[var(--status-won-bg)] text-[var(--status-won-fg)]`); callers
 * resolve it (incl. their own default fallback). `whitespace-nowrap`
 * keeps the chip from wrapping mid-label; the *consumer* layout owns
 * truncation of any adjacent text (`min-w-0 truncate` sibling) and
 * passes `className="shrink-0"` when the pill shares a flex row.
 *
 * Deliberately NOT adopted by the two intentional size variants:
 * `BatchStatusPill` (d365) and the `run-live-progress` inline chip use
 * `text-[11px]` — a different chip, not this one; folding them in
 * would silently resize them.
 */
export const PILL_BASE =
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium leading-tight whitespace-nowrap";

export interface PillProps {
  /** Paired bg/fg token classes; the caller resolves its own default. */
  variant?: string;
  className?: string;
  children: ReactNode;
}

export function Pill({ variant, className, children }: PillProps) {
  return (
    <span className={cn(PILL_BASE, variant, className)}>{children}</span>
  );
}
