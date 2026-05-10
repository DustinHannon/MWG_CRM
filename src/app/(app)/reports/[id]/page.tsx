import { notFound } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { ReportActionMenu } from "@/components/reports/report-action-menu";
import { ReportRunner } from "@/components/reports/report-runner";
import { requireSession } from "@/lib/auth-helpers";
import {
  assertCanViewReport,
  executeReport,
} from "@/lib/reports/access";
import { getReportById } from "@/lib/reports/repository";
import { getEntityMeta } from "@/lib/reports/schemas";
import type {
  ReportEntityType,
  ReportMetric,
  ReportVisualization,
} from "@/db/schema/saved-reports";
import type { RealtimeEntity } from "@/hooks/realtime/use-realtime-poll";

export const dynamic = "force-dynamic";

// Marketing entities (marketing_campaign / marketing_email_event /
// email_send_log) intentionally have no realtime subscription — they
// don't need live reactivity for reporting (events stream in via the
// SendGrid webhook on a separate path and aren't user-edited). When
// the entity isn't present in this map, the page skips PageRealtime /
// PagePoll mounting.
const ENTITY_TO_REALTIME: Partial<Record<ReportEntityType, RealtimeEntity>> = {
  lead: "leads",
  account: "accounts",
  contact: "contacts",
  opportunity: "opportunities",
  task: "tasks",
  activity: "activities",
};

export default async function ReportRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireSession();
  const { id } = await params;
  const report = await getReportById(id);
  if (!report) notFound();

  await assertCanViewReport(report, viewer);

  const result = await executeReport(report, viewer);
  const entityType = report.entityType as ReportEntityType;
  const meta = getEntityMeta(entityType);
  const metrics = (report.metrics as ReportMetric[]) ?? [];

  const canEdit = !report.isBuiltin && (viewer.isAdmin || report.ownerId === viewer.id);
  const canDelete = canEdit;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Reports", href: "/reports" },
          { label: report.name },
        ]}
      />
      {ENTITY_TO_REALTIME[entityType] ? (
        <>
          <PageRealtime entities={[ENTITY_TO_REALTIME[entityType]!]} />
          <PagePoll entities={[ENTITY_TO_REALTIME[entityType]!]} />
        </>
      ) : null}

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            {meta.label} report
          </p>
          <h1 className="mt-1 text-2xl font-semibold font-display">
            {report.name}
          </h1>
          {report.description ? (
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {report.description}
            </p>
          ) : null}
          <p className="mt-2 text-[11px] text-muted-foreground/80">
            Generated for {viewer.displayName} at{" "}
            <UserTime value={new Date()} />
          </p>
        </div>
        <ReportActionMenu
          reportId={report.id}
          reportName={report.name}
          isShared={report.isShared}
          isBuiltin={report.isBuiltin}
          canEdit={canEdit}
          canDelete={canDelete}
          definition={{
            name: report.name,
            description: report.description,
            entityType: report.entityType,
            fields: report.fields as string[],
            filters: report.filters as Record<string, unknown>,
            groupBy: report.groupBy as string[],
            metrics: report.metrics as unknown[],
            visualization: report.visualization,
          }}
        />
      </div>

      <GlassCard className="mt-8 p-6">
        <ReportRunner
          reportId={report.id}
          visualization={report.visualization as ReportVisualization}
          rows={result.rows}
          columns={result.columns}
          groupBy={report.groupBy as string[]}
          reportName={report.name}
          metricLabels={{
            primary: metrics[0]?.alias,
            secondary: metrics[1]?.alias,
          }}
        />
      </GlassCard>
    </div>
  );
}
