import { cn } from "@/lib/utils";

/**
 * colored status pill. Supports lead status, opportunity
 * stage, and task status. Background + foreground are paired tokens
 * defined in globals.css under `:root` and `.dark` so contrast holds
 * in both themes.
 *
 * Unknown values fall back to the neutral `--status-default-*` pair
 * and emit a console warning so we notice missing variants in dev.
 */

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "unqualified"
  | "converted"
  | "lost";

export type OpportunityStage =
  | "prospecting"
  | "qualification"
  | "proposal"
  | "negotiation"
  | "closed_won"
  | "closed_lost";

export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";

type AnyStatus = LeadStatus | OpportunityStage | TaskStatus;

const VARIANTS: Record<string, string> = {
  // Lead status
  new: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  contacted: "bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
  qualified:
    "bg-[var(--status-qualification-bg)] text-[var(--status-qualification-fg)]",
  unqualified: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  converted: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  lost: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",

  // Opportunity stage
  prospecting: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  qualification:
    "bg-[var(--status-qualification-bg)] text-[var(--status-qualification-fg)]",
  proposal: "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
  negotiation:
    "bg-[var(--status-negotiation-bg)] text-[var(--status-negotiation-fg)]",
  closed_won: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  closed_lost: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",

  // Task status
  open: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  in_progress:
    "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
  completed: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  cancelled: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
};

const LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  unqualified: "Unqualified",
  converted: "Converted",
  lost: "Lost",
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed-won",
  closed_lost: "Closed-lost",
  open: "Open",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export interface StatusPillProps {
  status: AnyStatus | string;
  className?: string;
}

export function StatusPill({ status, className }: StatusPillProps) {
  const variant =
    VARIANTS[status] ??
    "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  const label = LABELS[status] ?? status;
  if (!(status in VARIANTS) && typeof window !== "undefined") {
    // console.warn allowed here per CLAUDE.md "Errors and logging"
    // as a client-side diagnostic for unknown enum values. The
    // component falls back to a default-styled pill so the UI
    // stays usable.
    console.warn(`StatusPill: unknown status "${status}", using default`);
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
