import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { MarketingAuditListClient } from "./_components/audit-list-client";

export const dynamic = "force-dynamic";

/**
 * Marketing audit log. Listing of every `marketing.*` event in
 * `audit_log`. Filters surface as a typed form (search / type /
 * user-uuid / date range).
 *
 * Visibility:
 * - Admin can filter by any user.
 * - Non-admin only sees their own actions plus system-fired events
 *   (the API route scopes accordingly).
 */
export default async function MarketingAuditPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingAuditView) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        You don&apos;t have access to the marketing audit log.
      </div>
    );
  }

  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.auditIndex()} />
      <MarketingAuditListClient
        timePrefs={timePrefs}
        adminCanFilterUser={user.isAdmin}
      />
    </div>
  );
}
