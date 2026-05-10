import { CategorySection } from "@/components/reports/category-section";
import { ReportList } from "@/components/reports/report-list";
import { groupBuiltinReports } from "@/lib/reports/categories";
import type { ReportListItem } from "@/lib/reports/repository";

/**
 * Phase 24 — server component that lays out built-in reports in
 * expandable category sections.
 *
 * The card grid (`<ReportList>`) is rendered HERE on the server,
 * inside each `<CategorySection>` as children. The CategorySection
 * itself is a "use client" component that owns the toggle state and
 * visibility wrapper. This split keeps `server-only` modules
 * (UserTime in ReportList, auth in user-time, etc.) out of the
 * client bundle while still letting the disclosure toggle live in a
 * client component.
 *
 * Your-reports stays a flat `<ReportList>` (rendered directly on
 * the page) because the "last edited" order matters more than topic
 * for personal items.
 */

interface BuiltInReportsProps {
  reports: ReportListItem[];
}

export function BuiltInReports({ reports }: BuiltInReportsProps) {
  const groups = groupBuiltinReports(reports);

  if (groups.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border/60 bg-muted/10 p-8 text-center text-sm text-muted-foreground">
        No built-in reports installed yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group, index) => (
        <CategorySection
          key={group.category.key}
          categoryKey={group.category.key}
          label={group.category.label}
          count={group.reports.length}
          // First non-empty category opens by default; rest start
          // collapsed. localStorage overrides this on subsequent
          // visits.
          defaultExpanded={index === 0}
        >
          <ReportList reports={group.reports} emptyMessage="" />
        </CategorySection>
      ))}
    </div>
  );
}
