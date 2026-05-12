import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Weight = "1" | "2" | "3";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  weight?: Weight;
  /** Apply hover/transition affordance for clickable surfaces. */
  interactive?: boolean;
}

/**
 * GlassCard — primitive. Renders a translucent, blurred surface
 * matching the brand-navy aesthetic.
 *
 * Three weights:
 * 1 — default cards/panels (translucent).
 * 2 — elevated cards (hover, active, user panel).
 * 3 — near-opaque (modals, popovers).
 *
 * Do NOT use for form inputs or data table cells (readability). Use for
 * panels, KPI cards, modals, popovers, sidebar shell, top bar.
 */
export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className, weight = "1", interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "glass-surface",
        weight === "2" && "glass-surface--2",
        weight === "3" && "glass-surface--3",
        interactive && "glass-surface--interactive",
        className,
      )}
      {...props}
    />
  ),
);
GlassCard.displayName = "GlassCard";
