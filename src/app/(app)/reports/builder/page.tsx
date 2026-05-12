import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
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
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Reports", href: "/reports" },
          { label: "New report" },
        ]}
      />
      <StandardPageHeader
        kicker="Reports"
        title="New report"
        fontFamily="display"
        description={
          <>
            Pick an entity, choose fields and group-bys; the preview updates
            as you go.
          </>
        }
      />

      <div className="mt-8">
        <ReportBuilder mode="create" />
      </div>
    </div>
  );
}
