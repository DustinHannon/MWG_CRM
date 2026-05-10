import { cn } from "@/lib/utils";

/**
 * Phase 23 — status pill for D365 import runs. Mirrors the
 * `--status-*` CSS variables used by the global StatusPill and
 * widens the variant set for the eight run statuses, with explicit
 * red for `paused_for_review`, green for `completed`, gray for
 * `aborted` per the brief.
 */

const STATUS_LABEL: Record<string, string> = {
  created: "Created",
  fetching: "Fetching",
  mapping: "Mapping",
  reviewing: "Reviewing",
  committing: "Committing",
  paused_for_review: "Paused — review",
  completed: "Completed",
  aborted: "Aborted",
};

const STATUS_VARIANT: Record<string, string> = {
  created: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
  fetching: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  mapping: "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
  reviewing:
    "bg-[var(--status-qualification-bg)] text-[var(--status-qualification-fg)]",
  committing:
    "bg-[var(--status-negotiation-bg)] text-[var(--status-negotiation-fg)]",
  paused_for_review: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  completed: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  aborted: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
};

export function RunStatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const variant =
    STATUS_VARIANT[status] ??
    "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  const label = STATUS_LABEL[status] ?? status;
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

const BATCH_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  fetched: "Fetched",
  reviewing: "Reviewing",
  approved: "Approved",
  rejected: "Rejected",
  committed: "Committed",
  failed: "Failed",
};

const BATCH_STATUS_VARIANT: Record<string, string> = {
  pending: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
  fetched: "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  reviewing:
    "bg-[var(--status-qualification-bg)] text-[var(--status-qualification-fg)]",
  approved:
    "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
  rejected: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  committed: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  failed: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
};

export function BatchStatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const variant =
    BATCH_STATUS_VARIANT[status] ??
    "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  const label = BATCH_STATUS_LABEL[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap",
        variant,
        className,
      )}
    >
      {label}
    </span>
  );
}
