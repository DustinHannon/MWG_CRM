import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { TemplatesListClient } from "./_components/templates-list-client";

export const dynamic = "force-dynamic";

/**
 * Templates list. Read-only listing of marketing_templates with status
 * pill, visibility pill, creator, and last-edited stamp. The
 * drag-drop editor (Unlayer) mounts from /marketing/templates/[id]
 * and /marketing/templates/new.
 *
 * Visibility: global templates are visible to everyone with
 * template-view permissions; personal templates are visible only to
 * their creator. Admins bypass the visibility filter via
 * `listTemplatesCursor`'s isAdmin flag.
 */
export default async function TemplatesPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingTemplatesView) {
    redirect("/marketing");
  }

  const timePrefs = await getCurrentUserTimePrefs();
  const canCreate = user.isAdmin || perms.canMarketingTemplatesCreate;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.templatesIndex()} />
      <TemplatesListClient timePrefs={timePrefs} canCreate={canCreate} />
    </div>
  );
}
