import { requireAdmin } from "@/lib/auth-helpers";
import { BreadcrumbsSetter } from "@/components/breadcrumbs/breadcrumbs-setter";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { listVerificationStatus } from "@/lib/domain-verification";
import { DomainStatusClient } from "./domain-status-client";

export const dynamic = "force-dynamic";

export default async function DomainStatusPage() {
  await requireAdmin();
  const rows = await listVerificationStatus();

  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <>
      <BreadcrumbsSetter crumbs={adminCrumbs.domainStatus()} />
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <DomainStatusClient
          timePrefs={timePrefs}
          rows={rows.map((r) => ({
            id: r.id,
            serviceName: r.serviceName,
            configuredUrl: r.configuredUrl,
            expectedUrl: r.expectedUrl,
            lastCheckedAtIso: r.lastCheckedAt?.toISOString() ?? null,
            status: r.status,
            errorDetail: r.errorDetail,
            manuallyConfirmedById: r.manuallyConfirmedById,
            manuallyConfirmedAtIso: r.manuallyConfirmedAt?.toISOString() ?? null,
          }))}
        />
      </div>
    </>
  );
}
