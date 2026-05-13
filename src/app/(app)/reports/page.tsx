import Link from "next/link";
import { Plus } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { BuiltInReports } from "@/components/reports/built-in-reports";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { isMarketingReportEntity } from "@/lib/reports/categories";
import { listBuiltinReports } from "@/lib/reports/repository";
import { ReportsListClient } from "./_components/reports-list-client";

export const dynamic = "force-dynamic";

/**
 * /reports — top-level list. Two sections (built-in collapsible
 * catalog + user-and-shared infinite scroll). New report CTA in the
 * top right.
 */
export default async function ReportsListPage() {
  const viewer = await requireSession();
  const [builtin, perms] = await Promise.all([
    listBuiltinReports(),
    getPermissions(viewer.id),
  ]);

  // Marketing-entity reports are gated to admin + canMarketingReportsView
  // per src/lib/reports/access.ts. Filter them out of the built-in
  // list before the categorization layer so non-marketing users
  // don't see cards that would 403 on click.
  const canSeeMarketing = viewer.isAdmin || perms.canMarketingReportsView;
  const visibleBuiltin = canSeeMarketing
    ? builtin
    : builtin.filter((r) => !isMarketingReportEntity(r.entityType));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Reports" }]} />

      <StandardPageHeader
        kicker="Reports"
        title="Insights & saved reports"
        fontFamily="display"
        description={
          <>
            Built-in reports cover common pipeline questions. Build your own
            to pivot the data — every report is scoped to what you can see.
          </>
        }
        actions={
          <Link
            href="/reports/builder"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New report
          </Link>
        }
      />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Built-in reports
        </h2>
        <BuiltInReports reports={visibleBuiltin} />
      </section>

      <section className="mt-10">
        <ReportsListClient />
      </section>
    </div>
  );
}
