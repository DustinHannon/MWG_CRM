import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { EntraSyncClient } from "./_components/entra-sync-client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function AdminUsersSyncPage() {
  // Hard admin gate — URL-guessing a non-admin redirects to /dashboard
  // (requireAdmin → requireSession → redirect). Never renders for them.
  await requireAdmin();
  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.usersSync()} />
      <EntraSyncClient />
    </div>
  );
}
