import { cn } from "@/lib/utils";

/**
 * colored activity-verb pill for the /notifications activity feed.
 * Mirrors `status-pill.tsx` / `priority-pill.tsx` exactly — same base
 * span, same paired `--status-*` tokens (so contrast holds in both
 * themes), same unknown-value fallback + dev warning. Kept as its own
 * per-concept component, matching the established one-pill-per-enum
 * pattern (StatusPill, PriorityPill) rather than overloading those
 * with an unrelated enum.
 *
 * Verbs are the `ActivityVerb` set composed by `emitActivity`
 * (`src/lib/notifications.ts`): Added / Updated / Archived / Restored.
 * Tone mapping reuses the shared status palette: Added & Restored read
 * positive (won/green), Updated neutral-active (contacted/blue),
 * Archived negative (lost/red).
 */

export type ActivityVerb = "Added" | "Updated" | "Archived" | "Restored";

const VARIANTS: Record<string, string> = {
  Added: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  Restored: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  Updated: "bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
  Archived: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
};

export interface ActivityPillProps {
  verb: string;
  className?: string;
}

export function ActivityPill({ verb, className }: ActivityPillProps) {
  const variant =
    VARIANTS[verb] ??
    "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  if (!(verb in VARIANTS) && typeof window !== "undefined") {
    // console.warn allowed here per CLAUDE.md "Errors and logging"
    // as a client-side diagnostic for unknown enum values — the pill
    // still renders with the neutral default so the UI stays usable.
    console.warn(`ActivityPill: unknown verb "${verb}", using default`);
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium leading-tight whitespace-nowrap",
        variant,
        className,
      )}
    >
      {verb}
    </span>
  );
}
