import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { SuppressionsListClient } from "./_components/suppressions-list-client";

export const dynamic = "force-dynamic";

/**
 * Suppressions view. Most rows are mirrored from SendGrid via the
 * hourly cron + event webhook. Admins with the manual-add permission
 * can also suppress an address directly from this page; admins with
 * the manual-remove permission can re-subscribe an address with a
 * recorded reason.
 */
export default async function SuppressionsPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingSuppressionsView) {
    redirect("/marketing");
  }

  const timePrefs = await getCurrentUserTimePrefs();
  const canAdd = user.isAdmin || perms.canMarketingSuppressionsAdd;
  const canRemove = user.isAdmin || perms.canMarketingSuppressionsRemove;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.suppressionsIndex()} />
      <SuppressionsListClient
        timePrefs={timePrefs}
        canAdd={canAdd}
        canRemove={canRemove}
      />
    </div>
  );
}
