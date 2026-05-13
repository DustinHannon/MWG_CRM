import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListClient } from "@/components/archived/archived-list-client";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteTaskAction,
  restoreTaskAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived tasks view. Mirrors `/leads/archived`.
 *
 * Migrated to infinite-scroll via the shared `ArchivedListClient`.
 */
export default async function ArchivedTasksPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Tasks", href: "/tasks" },
            { label: "Archived" },
          ]}
        />
        <p className="text-sm text-muted-foreground">Admin only.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Tasks", href: "/tasks" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />
      <ArchivedListClient
        headerTitle="Archived tasks"
        headerDescription="Hidden from the main views."
        headerActions={
          <Link
            href="/tasks"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            Back to tasks
          </Link>
        }
        subtitleHeader="Detail"
        fetchUrl="/api/tasks/archived"
        queryKey="archived-tasks"
        restoreAction={restoreTaskAction}
        hardDeleteAction={hardDeleteTaskAction}
        emptyMessage="No archived tasks."
      />
    </div>
  );
}
