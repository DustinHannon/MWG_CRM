import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { ReportBuilder } from "@/components/reports/report-builder";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * /reports/builder — new report wizard. Reuses <ReportBuilder> in
 * "create" mode. The builder handles validation, live preview, and
 * the POST to /api/reports.
 */
export default async function ReportBuilderPage() {
  await requireSession();

  return (
    <div className="px-10 py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Reports", href: "/reports" },
          { label: "New report" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Reports
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">New report</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Pick an entity, choose fields and group-bys, and the preview
        updates as you go. Save to share or come back to it later.
      </p>

      <div className="mt-8">
        <ReportBuilder mode="create" />
      </div>
    </div>
  );
}
