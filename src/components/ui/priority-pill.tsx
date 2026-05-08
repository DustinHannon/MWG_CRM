import { cn } from "@/lib/utils";

/**
 * Phase 11 — colored priority pill. Spec sketches a 5-step scale
 * (very low → very high). The DB only has a 4-step task_priority enum
 * (low/normal/high/urgent), but the lead_rating enum (cold/warm/hot)
 * is also rendered here so we can lift it out of plain text. Pass any
 * of those literals; unknown values fall back to a neutral pill with a
 * console warning.
 */

export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type LeadRating = "cold" | "warm" | "hot";
type AnyPriority = TaskPriority | LeadRating;

const VARIANTS: Record<string, string> = {
  low: "bg-[var(--priority-low-bg)] text-[var(--priority-low-fg)]",
  normal: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
  high: "bg-[var(--priority-high-bg)] text-[var(--priority-high-fg)]",
  urgent:
    "bg-[var(--priority-very-high-bg)] text-[var(--priority-very-high-fg)]",
  cold: "bg-[var(--priority-very-low-bg)] text-[var(--priority-very-low-fg)]",
  warm: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
  hot: "bg-[var(--priority-very-high-bg)] text-[var(--priority-very-high-fg)]",
};

const LABELS: Record<string, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
  cold: "Cold",
  warm: "Warm",
  hot: "Hot",
};

export interface PriorityPillProps {
  priority: AnyPriority | string;
  className?: string;
}

export function PriorityPill({ priority, className }: PriorityPillProps) {
  const variant =
    VARIANTS[priority] ??
    "bg-[var(--priority-default-bg)] text-[var(--priority-default-fg)]";
  const label = LABELS[priority] ?? priority;
  if (!(priority in VARIANTS) && typeof window !== "undefined") {
    console.warn(
      `PriorityPill: unknown priority "${priority}", using default`,
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium leading-tight whitespace-nowrap",
        variant,
        className,
      )}
    >
      {label}
    </span>
  );
}
