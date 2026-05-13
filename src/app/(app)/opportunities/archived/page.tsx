import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListClient } from "@/components/archived/archived-list-client";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteOpportunityAction,
  restoreOpportunityAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived opportunities view. Mirrors `/leads/archived`.
 *
 * Migrated to infinite-scroll via the shared `ArchivedListClient`.
 */
export default async function ArchivedOpportunitiesPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Opportunities", href: "/opportunities" },
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
          { label: "Opportunities", href: "/opportunities" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["opportunities"]} />
      <PagePoll entities={["opportunities"]} />
      <ArchivedListClient
        headerTitle="Archived opportunities"
        headerDescription="Hidden from the main views."
        headerActions={
          <Link
            href="/opportunities"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            Back to opportunities
          </Link>
        }
        subtitleHeader="Stage"
        fetchUrl="/api/opportunities/archived"
        queryKey="archived-opportunities"
        restoreAction={restoreOpportunityAction}
        hardDeleteAction={hardDeleteOpportunityAction}
        emptyMessage="No archived opportunities."
      />
    </div>
  );
}
