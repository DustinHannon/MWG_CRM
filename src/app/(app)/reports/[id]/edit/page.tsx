import { notFound } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { ReportBuilder } from "@/components/reports/report-builder";
import { requireSession } from "@/lib/auth-helpers";
import { assertCanEditReport } from "@/lib/reports/access";
import { getReportById } from "@/lib/reports/repository";
import type {
  ReportEntityType,
  ReportMetric,
  ReportVisualization,
} from "@/db/schema/saved-reports";

export const dynamic = "force-dynamic";

export default async function ReportEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireSession();
  const { id } = await params;
  const report = await getReportById(id);
  if (!report) notFound();

  await assertCanEditReport(report, viewer);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Reports", href: "/reports" },
          { label: report.name, href: `/reports/${id}` },
          { label: "Edit" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Reports
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">
        Edit: {report.name}
      </h1>

      <div className="mt-8">
        <ReportBuilder
          mode="edit"
          initial={{
            id: report.id,
            name: report.name,
            description: report.description,
            entityType: report.entityType as ReportEntityType,
            fields: report.fields as string[],
            filters: report.filters as Record<
              string,
              Partial<Record<string, unknown>>
            >,
            groupBy: report.groupBy as string[],
            metrics: report.metrics as ReportMetric[],
            visualization: report.visualization as ReportVisualization,
            isShared: report.isShared,
          }}
        />
      </div>
    </div>
  );
}
