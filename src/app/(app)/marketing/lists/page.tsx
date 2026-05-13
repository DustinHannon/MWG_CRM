import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { ListsListClient } from "./_components/lists-list-client";

export const dynamic = "force-dynamic";

/**
 * Lists index. Read-only listing of marketing_lists with type pill
 * (Dynamic / Static), member count, last-refreshed stamp, and
 * creator. Detail/edit + create flows mount from
 * /marketing/lists/[id], /marketing/lists/new, and
 * /marketing/lists/new/import.
 */
export default async function ListsPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingListsView) {
    redirect("/marketing");
  }

  const timePrefs = await getCurrentUserTimePrefs();
  const canCreate = user.isAdmin || perms.canMarketingListsCreate;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsIndex()} />
      <ListsListClient timePrefs={timePrefs} canCreate={canCreate} />
    </div>
  );
}
