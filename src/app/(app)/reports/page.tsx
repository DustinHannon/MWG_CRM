import Link from "next/link";
import { Plus } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { BuiltInReports } from "@/components/reports/built-in-reports";
import { ReportList } from "@/components/reports/report-list";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { isMarketingReportEntity } from "@/lib/reports/categories";
import {
  listBuiltinReports,
  listUserAndSharedReports,
} from "@/lib/reports/repository";

export const dynamic = "force-dynamic";

/**
 * /reports — top-level list. Two sections (built-in + your reports +
 * shared). New report CTA in the top right.
 */
export default async function ReportsListPage() {
  const viewer = await requireSession();
  const [builtin, mine, perms] = await Promise.all([
    listBuiltinReports(),
    listUserAndSharedReports(viewer.id),
    getPermissions(viewer.id),
  ]);

  // Marketing-entity reports are gated to admin + canManageMarketing
  // per src/lib/reports/access.ts. Filter them out of the built-in
  // list before the categorization layer so non-marketing users
  // don't see cards that would 403 on click. Mirrors the same
  // entity-set used for category bucketing.
  const canSeeMarketing = viewer.isAdmin || perms.canManageMarketing;
  const visibleBuiltin = canSeeMarketing
    ? builtin
    : builtin.filter((r) => !isMarketingReportEntity(r.entityType));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Reports" }]} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Reports
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">
            Insights &amp; saved reports
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Built-in reports cover the common pipeline questions. Build
            your own to slice the data your way — every report is scoped
            to what you&apos;re allowed to see.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/reports/builder"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New report
          </Link>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Built-in reports
        </h2>
        <BuiltInReports reports={visibleBuiltin} />
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Your reports &amp; shared
        </h2>
        <ReportList
          reports={mine}
          emptyMessage="You haven't saved a report yet. Click New report to get started."
          showOwner
        />
      </section>
    </div>
  );
}
