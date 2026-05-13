import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListClient } from "@/components/archived/archived-list-client";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteContactAction,
  restoreContactAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * admin-only archived contacts view. Mirrors `/leads/archived`. Shows
 * soft-deleted rows with Restore + permanent-Delete actions.
 *
 * Migrated to infinite-scroll via the shared `ArchivedListClient`.
 */
export default async function ArchivedContactsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Contacts", href: "/contacts" },
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
          { label: "Contacts", href: "/contacts" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["contacts"]} />
      <PagePoll entities={["contacts"]} />
      <ArchivedListClient
        headerTitle="Archived contacts"
        headerDescription="Hidden from the main views."
        headerActions={
          <Link
            href="/contacts"
            className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
          >
            Back to contacts
          </Link>
        }
        subtitleHeader="Email"
        fetchUrl="/api/contacts/archived"
        queryKey="archived-contacts"
        restoreAction={restoreContactAction}
        hardDeleteAction={hardDeleteContactAction}
        emptyMessage="No archived contacts."
      />
    </div>
  );
}
