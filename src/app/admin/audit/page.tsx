import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { RetentionBanner } from "@/components/admin/retention-banner";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { listAuditTargetTypes } from "@/lib/audit-cursor";
import { AuditListClient } from "./_components/audit-list-client";

export const dynamic = "force-dynamic";

interface AuditSearchParams {
  q?: string;
  action?: string;
  category?: string;
  target_type?: string;
  request_id?: string;
  created_at_gte?: string;
  created_at_lte?: string;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [timePrefs, targetTypes] = await Promise.all([
    getCurrentUserTimePrefs(),
    listAuditTargetTypes(),
  ]);

  const initialFilters = {
    q: sp.q ?? "",
    action: sp.action ?? "",
    category: sp.category ?? "",
    targetType: sp.target_type ?? "",
    requestId: sp.request_id ?? "",
    from: sp.created_at_gte ?? "",
    to: sp.created_at_lte ?? "",
  };

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.audit()} />
      <RetentionBanner days={730} label="Activity logs" />
      <AuditListClient
        timePrefs={timePrefs}
        targetTypes={targetTypes}
        initialFilters={initialFilters}
      />
    </div>
  );
}
