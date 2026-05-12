import { requireAdmin } from "@/lib/auth-helpers";
import { BreadcrumbsSetter } from "@/components/breadcrumbs/breadcrumbs-setter";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { listVerificationStatus } from "@/lib/domain-verification";
import { DomainStatusClient } from "./domain-status-client";

export const dynamic = "force-dynamic";

export default async function DomainStatusPage() {
  await requireAdmin();
  const rows = await listVerificationStatus();

  return (
    <>
      <BreadcrumbsSetter crumbs={adminCrumbs.domainStatus()} />
      <DomainStatusClient rows={rows.map((r) => ({
        id: r.id,
        serviceName: r.serviceName,
        configuredUrl: r.configuredUrl,
        expectedUrl: r.expectedUrl,
        lastCheckedAtIso: r.lastCheckedAt?.toISOString() ?? null,
        status: r.status,
        errorDetail: r.errorDetail,
        manuallyConfirmedById: r.manuallyConfirmedById,
        manuallyConfirmedAtIso: r.manuallyConfirmedAt?.toISOString() ?? null,
      }))} />
    </>
  );
}
