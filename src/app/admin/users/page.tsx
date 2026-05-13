import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireAdmin } from "@/lib/auth-helpers";
import { UsersListClient } from "./_components/users-list-client";

export const dynamic = "force-dynamic";

const RECENT_JIT_FILTER = "jit-7d";

interface UsersListSearchParams {
  recent?: string;
}

export default async function UsersListPage({
  searchParams,
}: {
  searchParams: Promise<UsersListSearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const initialRecent: "all" | "jit-7d" =
    sp.recent === RECENT_JIT_FILTER ? "jit-7d" : "all";
  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.users()} />
      <UsersListClient timePrefs={timePrefs} initialRecent={initialRecent} />
    </div>
  );
}
