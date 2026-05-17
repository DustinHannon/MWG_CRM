import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { appCrumbs } from "@/lib/navigation/breadcrumbs";
import { NotificationsListClient } from "./_components/notifications-list-client";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  await requireSession();
  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={appCrumbs.notifications()} />
      {/*
        The `notifications` realtime subscription is mounted once at the
        authenticated layout (it drives the topbar bell). Re-subscribing
        here would reuse the same channel name and throw "cannot add
        postgres_changes callbacks after subscribe()", so this page does
        NOT mount PageRealtime. The list itself is a client infinite
        query; PagePoll is retained as the off-publication fallback,
        matching the prior page (live list refresh is out of scope here).
      */}
      <PagePoll entities={["notifications"]} />
      <NotificationsListClient timePrefs={timePrefs} />
    </div>
  );
}
