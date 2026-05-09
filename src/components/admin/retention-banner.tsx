import { ShieldCheck } from "lucide-react";

interface RetentionBannerProps {
  days?: number;
  label?: string;
}

/**
 * Phase 13 — visible retention notice for both `/admin/audit` and
 * `/admin/api-usage`. Sits above the filter bar so it is the first
 * thing on the page; satisfies the brief's requirement that retention
 * be visible, not buried in a tooltip.
 */
export function RetentionBanner({
  days = 730,
  label = "Activity logs",
}: RetentionBannerProps) {
  const years = Math.round(days / 365);
  return (
    <div className="mb-6 flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {label} are retained for{" "}
        <strong className="text-foreground">
          {years} years ({days} days)
        </strong>{" "}
        and then automatically deleted. Retention is enforced by a daily
        background job; deletions are themselves logged.
      </span>
    </div>
  );
}
