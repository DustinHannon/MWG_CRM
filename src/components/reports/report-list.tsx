import Link from "next/link";
import {
  BarChart3,
  CircleGauge,
  Filter,
  GitBranch,
  PieChart,
  Table as TableIcon,
  TrendingUp,
} from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import type { ReportListItem } from "@/lib/reports/repository";

/**
 * Phase 11 — server-friendly card grid for /reports. Each card is a
 * Link to /reports/[id]; no client interactivity here beyond standard
 * `<a>` navigation. Visualization gets a small icon, entity type is
 * surfaced as an uppercase pill.
 */

const VIS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  bar: BarChart3,
  line: TrendingUp,
  pie: PieChart,
  table: TableIcon,
  funnel: Filter,
  kpi: CircleGauge,
};

export interface ReportListProps {
  reports: ReportListItem[];
  emptyMessage: string;
  showOwner?: boolean;
}

export function ReportList({
  reports,
  emptyMessage,
  showOwner = false,
}: ReportListProps) {
  if (reports.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border/60 bg-muted/10 p-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {reports.map((r) => (
        <ReportCard key={r.id} report={r} showOwner={showOwner} />
      ))}
    </div>
  );
}

function ReportCard({
  report,
  showOwner,
}: {
  report: ReportListItem;
  showOwner: boolean;
}) {
  const Icon = VIS_ICON[report.visualization] ?? TableIcon;
  return (
    <Link href={`/reports/${report.id}`} className="block focus:outline-none">
      <GlassCard
        interactive
        weight="2"
        className="flex h-full flex-col gap-3 p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-foreground/70">
            <Icon className="h-4 w-4" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {report.entityType}
            </span>
          </div>
          {report.isShared && !report.isBuiltin ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              <GitBranch className="h-3 w-3" /> Shared
            </span>
          ) : null}
        </div>
        <h3 className="text-base font-semibold leading-snug text-foreground">
          {report.name}
        </h3>
        {report.description ? (
          <p className="text-sm text-muted-foreground line-clamp-3">
            {report.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/60">
            No description.
          </p>
        )}
        <div className="mt-auto flex items-center justify-between text-[11px] text-muted-foreground/80">
          <span>
            Updated <UserTime value={report.updatedAt} mode="date" />
          </span>
          {showOwner && report.ownerName ? (
            <span className="truncate">By {report.ownerName}</span>
          ) : null}
        </div>
      </GlassCard>
    </Link>
  );
}
