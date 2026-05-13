import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { CampaignsListClient } from "./_components/campaigns-list-client";

export const dynamic = "force-dynamic";

/**
 * Campaigns list. Read-only listing of marketing_campaigns showing
 * template + list + status + sent / opens counters + last updated.
 * Send-flow + scheduler live on /marketing/campaigns/new and
 * /marketing/campaigns/[id].
 */
export default async function CampaignsPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingCampaignsView) {
    redirect("/marketing");
  }

  const timePrefs = await getCurrentUserTimePrefs();
  const canCreate = user.isAdmin || perms.canMarketingCampaignsCreate;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.campaignsIndex()} />
      <CampaignsListClient timePrefs={timePrefs} canCreate={canCreate} />
    </div>
  );
}
