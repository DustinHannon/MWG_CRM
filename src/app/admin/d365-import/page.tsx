import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime, getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { isD365Configured } from "@/lib/d365";
import { QuickPullButtons } from "@/components/admin/d365-import/quick-pull-buttons";
import { NewRunModal } from "./_components/new-run-modal";
import { D365RunsListClient } from "./_components/d365-runs-list-client";

export const dynamic = "force-dynamic";

interface RunListSearchParams {
  status?: string;
  entity?: string;
}

export default async function D365ImportPage({
  searchParams,
}: {
  searchParams: Promise<RunListSearchParams>;
}) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const configured = isD365Configured();

  const [timePrefs, recentAudit] = await Promise.all([
    getCurrentUserTimePrefs(),
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetId: auditLog.targetId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorId, user.id),
          ilike(auditLog.action, "d365.import.%"),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(15),
  ]);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.d365Import()} />

      <header className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Admin
        </p>
        <h1 className="text-2xl font-semibold text-foreground font-display">
          D365 CRM import
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Import from Dynamics 365 Sales in 100-record batches. Review and
          approve each batch before commit. Source <code>createdon</code> /{" "}
          <code>modifiedon</code> timestamps are preserved so historical
          records do not surface as new in recency reports.
        </p>
      </header>

      {!configured ? (
        <GlassCard className="p-4">
          <h2 className="mb-2 text-sm font-medium text-foreground">
            Configuration required
          </h2>
          <p className="text-sm text-muted-foreground">
            D365 credentials are not yet configured. Add{" "}
            <code>D365_CLIENT_ID</code>, <code>D365_CLIENT_SECRET</code>, and
            <code>D365_BASE_URL</code> to Vercel envs (production) and
            redeploy. Quick-pull buttons below will be disabled until
            configuration is detected.
          </p>
        </GlassCard>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">
            Pull next 100 of an entity
          </h2>
          <NewRunModal />
        </div>
        <QuickPullButtons disabled={!configured} />
      </section>

      <D365RunsListClient
        timePrefs={timePrefs}
        initialFilters={{
          status: sp.status ?? "",
          entity: sp.entity ?? "",
        }}
      />

      <section>
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Recent activity (your D365 import audit log)
          </summary>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-muted/20">
            {recentAudit.length === 0 ? (
              <li className="p-3 text-xs text-muted-foreground">
                No D365 import activity yet.
              </li>
            ) : (
              recentAudit.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between p-3 text-xs"
                >
                  <span className="font-mono text-foreground">{a.action}</span>
                  <span className="text-muted-foreground">
                    <UserTime value={a.createdAt.toISOString()} />
                  </span>
                </li>
              ))
            )}
          </ul>
        </details>
      </section>
    </div>
  );
}
