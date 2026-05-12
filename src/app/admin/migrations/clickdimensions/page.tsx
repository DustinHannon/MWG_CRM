import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import {
  clickdimensionsMigrations,
  type ClickDimensionsMigrationRow,
} from "@/db/schema/clickdimensions-migrations";
import { auditLog } from "@/db/schema/audit";
import { permissions } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireSession } from "@/lib/auth-helpers";
import {
  StandardEmptyState,
  StandardPageHeader,
} from "@/components/standard";
import { ClickDimensionsWorklistClient } from "./_components/worklist-client";

export const dynamic = "force-dynamic";

interface AuditEventLike {
  action: string;
  afterJson: unknown;
  createdAt: Date;
}

interface RunSummaryDisplay {
  runId: string | null;
  total: number | null;
  success: number | null;
  failed: number | null;
  skipped: number | null;
  durationMs: number | null;
  reason: string | null;
  createdAt: Date;
}

function parseLatestRunSummary(
  rows: AuditEventLike[],
): RunSummaryDisplay | null {
  const row = rows[0];
  if (!row) return null;
  const after = (row.afterJson ?? {}) as Record<string, unknown>;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" ? v : null;
  return {
    runId: typeof after.runId === "string" ? after.runId : null,
    total: numOrNull(after.total),
    success: numOrNull(after.success),
    failed: numOrNull(after.failed),
    skipped: numOrNull(after.skipped),
    durationMs: numOrNull(after.durationMs),
    reason: typeof after.reason === "string" ? after.reason : null,
    createdAt: row.createdAt,
  };
}

export default async function ClickDimensionsMigrationsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    const perm = await db
      .select({
        canMarketingMigrationsRun: permissions.canMarketingMigrationsRun,
      })
      .from(permissions)
      .where(eq(permissions.userId, user.id))
      .limit(1);
    if (!perm[0]?.canMarketingMigrationsRun) {
      redirect("/dashboard");
    }
  }

  const rows: ClickDimensionsMigrationRow[] = await db
    .select()
    .from(clickdimensionsMigrations)
    .orderBy(desc(clickdimensionsMigrations.extractedAt));

  const latestRunRows: AuditEventLike[] = await db
    .select({
      action: auditLog.action,
      afterJson: auditLog.afterJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.action, "marketing.template.migration.run_completed"))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  const latestRun = parseLatestRunSummary(latestRunRows);

  // Strip Date objects + non-serializable fields for the client island.
  const safeRows = rows.map((r) => ({
    id: r.id,
    cdTemplateId: r.cdTemplateId,
    cdTemplateName: r.cdTemplateName,
    cdSubject: r.cdSubject,
    cdCategory: r.cdCategory,
    editorType: r.editorType,
    status: r.status,
    attempts: r.attempts,
    extractedAt: r.extractedAt ? r.extractedAt.toISOString() : null,
    lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
    importedTemplateId: r.importedTemplateId,
    errorReason: r.errorReason,
    hasHtml: r.rawHtml !== null && r.rawHtml.length > 0,
    htmlBytes: r.rawHtml?.length ?? 0,
  }));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={adminCrumbs.migrationsClickDimensions()}
      />
      <StandardPageHeader
        title="ClickDimensions migration"
        description="Worklist of templates extracted from the legacy ClickDimensions UI."
      />

      {latestRun ? (
        <GlassCard className="mt-4 p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Last run
            </span>
            <span className="font-medium text-foreground">
              <UserTime value={latestRun.createdAt.toISOString()} />
            </span>
            {latestRun.total !== null ? (
              <span className="text-muted-foreground">
                {latestRun.success ?? 0}/{latestRun.total} succeeded
                {latestRun.failed ? `, ${latestRun.failed} failed` : ""}
                {latestRun.skipped ? `, ${latestRun.skipped} skipped` : ""}
              </span>
            ) : null}
            {latestRun.durationMs !== null ? (
              <span className="text-muted-foreground">
                {Math.round(latestRun.durationMs / 1000)}s
              </span>
            ) : null}
            {latestRun.reason && latestRun.reason !== "completed" ? (
              <span className="text-xs text-destructive">
                Ended: {latestRun.reason}
              </span>
            ) : null}
          </div>
        </GlassCard>
      ) : null}

      <div className="mt-4">
        {safeRows.length === 0 ? (
          <StandardEmptyState
            title="No migrations yet"
            description={
              <>
                Run the extraction script from{" "}
                <code className="text-xs">tools/clickdimensions-migration</code>{" "}
                to populate this worklist.
              </>
            }
          />
        ) : (
          <ClickDimensionsWorklistClient rows={safeRows} />
        )}
      </div>
    </div>
  );
}
