import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listAccountsForPicker } from "@/lib/accounts";
import { listContactsForAccountPicker } from "@/lib/opportunities";
import { OpportunityForm } from "./_components/opportunity-form";

export const dynamic = "force-dynamic";

export default async function NewOpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const accounts = await listAccountsForPicker(session.id, canViewAll);

  const prefilledAccountId =
    sp.accountId && accounts.some((a) => a.id === sp.accountId)
      ? sp.accountId
      : null;

  // When the account is prefilled, also pull its contacts so the
  // primary-contact picker is meaningful on first render. When no
  // account is prefilled the form still ships with an empty contact
  // list — switching accounts after load doesn't refetch contacts (a
  // future polish; tracked as a follow-up for sub-agent A).
  const contactsForAccount = await listContactsForAccountPicker(
    prefilledAccountId,
  );

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Opportunities", href: "/opportunities" },
          { label: "New" },
        ]}
      />
      <Link
        href={prefilledAccountId ? `/accounts/${prefilledAccountId}` : "/opportunities"}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {prefilledAccountId ? "← Back to account" : "← Back to opportunities"}
      </Link>
      <div className="mt-3">
        <StandardPageHeader
          kicker="New"
          title="Add opportunity"
          description={
            <>
              Select an account, then fill in the deal details.
            </>
          }
        />
      </div>

      <OpportunityForm
        accounts={accounts}
        defaultAccountId={prefilledAccountId}
        contacts={contactsForAccount}
      />
    </div>
  );
}
