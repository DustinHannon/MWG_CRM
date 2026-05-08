import Link from "next/link";
import { Plus } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { ReportList } from "@/components/reports/report-list";
import { requireSession } from "@/lib/auth-helpers";
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
  const [builtin, mine] = await Promise.all([
    listBuiltinReports(),
    listUserAndSharedReports(viewer.id),
  ]);

  return (
    <div className="px-10 py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Reports" }]} />

      <div className="flex items-end justify-between gap-4">
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
        <Link
          href="/reports/builder"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New report
        </Link>
      </div>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Built-in reports
        </h2>
        <ReportList
          reports={builtin}
          emptyMessage="No built-in reports installed yet."
        />
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
