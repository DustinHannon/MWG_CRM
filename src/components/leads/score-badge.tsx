import {
  formatUserTime,
  type TimePrefs,
} from "@/lib/format-time";
import { cn } from "@/lib/utils";

/**
 * Phase 4C — colored score badge. Renders next to the lead name on detail
 * pages, list rows, and Kanban cards. Tooltip surfaces last-scored time.
 *
 * Phase 5A — accept an optional `prefs` so the tooltip uses the user's
 * timezone + date format. When not provided, falls back to the default
 * prefs.
 */
export function ScoreBadge({
  score,
  band,
  scoredAt,
  prefs,
  className,
}: {
  score: number;
  band: "hot" | "warm" | "cool" | "cold" | string;
  scoredAt?: Date | string | null;
  prefs?: TimePrefs;
  className?: string;
}) {
  const styles: Record<string, string> = {
    hot: "bg-[var(--priority-very-high-bg)] text-[var(--priority-very-high-fg)] border-[var(--priority-very-high-fg)]/30",
    warm: "bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)] border-[var(--priority-medium-fg)]/30",
    cool: "bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)] border-[var(--status-contacted-fg)]/30",
    cold: "bg-muted/40 text-muted-foreground border-border",
  };
  const icons: Record<string, string> = {
    hot: "🔥",
    warm: "☀",
    cool: "🌤",
    cold: "❄",
  };
  const tooltip = scoredAt
    ? `Score ${score} · last computed ${formatUserTime(scoredAt, prefs)}`
    : `Score ${score} · not yet computed`;

  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
        styles[band] ?? styles.cold,
        className,
      )}
    >
      <span aria-hidden>{icons[band] ?? icons.cold}</span>
      <span className="capitalize">{band}</span>
      <span className="opacity-70">· {score}</span>
    </span>
  );
}
