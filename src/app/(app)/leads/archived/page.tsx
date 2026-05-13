import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListClient } from "@/components/archived/archived-list-client";
import { requireSession } from "@/lib/auth-helpers";
import { hardDeleteLeadAction, restoreLeadAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived leads view. Shows soft-deleted rows with
 * Restore + permanent-Delete actions. Cron `purge-archived` removes
 * them automatically after 30 days.
 *
 * Migrated to infinite-scroll: the canonical `StandardListPage` shell
 * drives cursor-paginated loads via `/api/leads/archived`. The
 * server-side page resolves admin auth + breadcrumbs, then hands off
 * to the shared `ArchivedListClient` component.
 */
export default async function ArchivedLeadsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Leads", href: "/leads" },
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
          { label: "Leads", href: "/leads" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["leads"]} />
      <PagePoll entities={["leads"]} />
      <ArchivedListClient
        headerTitle="Archived leads"
        headerDescription="Hidden from the main views. Auto-purged 30 days after archive."
        headerActions={
          <Link
            href="/leads"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            Back to leads
          </Link>
        }
        subtitleHeader="Company"
        fetchUrl="/api/leads/archived"
        queryKey="archived-leads"
        restoreAction={restoreLeadAction}
        hardDeleteAction={hardDeleteLeadAction}
        emptyMessage="No archived leads."
      />
    </div>
  );
}
