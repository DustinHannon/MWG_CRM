import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListClient } from "@/components/archived/archived-list-client";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteAccountAction,
  restoreAccountAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived accounts view. Mirrors `/leads/archived`. Shows
 * soft-deleted rows with Restore + permanent-Delete actions; cron
 * `purge-archived` (lead-only today) does not yet purge accounts, so
 * Hard delete is the only path until that's extended.
 *
 * Migrated to infinite-scroll via the shared `ArchivedListClient`.
 */
export default async function ArchivedAccountsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Accounts", href: "/accounts" },
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
          { label: "Accounts", href: "/accounts" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["accounts"]} />
      <PagePoll entities={["accounts"]} />
      <ArchivedListClient
        headerTitle="Archived accounts"
        headerDescription="Hidden from the main views."
        headerActions={
          <Link
            href="/accounts"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            Back to accounts
          </Link>
        }
        subtitleHeader="Industry"
        fetchUrl="/api/accounts/archived"
        queryKey="archived-accounts"
        restoreAction={restoreAccountAction}
        hardDeleteAction={hardDeleteAccountAction}
        emptyMessage="No archived accounts."
      />
    </div>
  );
}
