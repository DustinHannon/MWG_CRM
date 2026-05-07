import { cn } from "@/lib/utils";

/**
 * Phase 4C — colored score badge. Renders next to the lead name on detail
 * pages, list rows, and Kanban cards. Tooltip surfaces last-scored time.
 */
export function ScoreBadge({
  score,
  band,
  scoredAt,
  className,
}: {
  score: number;
  band: "hot" | "warm" | "cool" | "cold" | string;
  scoredAt?: Date | string | null;
  className?: string;
}) {
  const styles: Record<string, string> = {
    hot: "bg-red-500/15 text-red-300 border-red-400/30",
    warm: "bg-amber-500/15 text-amber-200 border-amber-400/30",
    cool: "bg-sky-500/15 text-sky-200 border-sky-400/30",
    cold: "bg-slate-500/15 text-slate-300 border-slate-400/30",
  };
  const icons: Record<string, string> = {
    hot: "🔥",
    warm: "☀",
    cool: "🌤",
    cold: "❄",
  };
  const tooltip = scoredAt
    ? `Score ${score} · last computed ${new Date(scoredAt).toLocaleString()}`
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
