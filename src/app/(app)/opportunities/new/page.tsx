import Link from "next/link";
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
    <div className="px-10 py-10">
      <Link
        href={prefilledAccountId ? `/accounts/${prefilledAccountId}` : "/opportunities"}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {prefilledAccountId ? "← Back to account" : "← Back to opportunities"}
      </Link>
      <p className="mt-3 text-xs uppercase tracking-[0.3em] text-muted-foreground/80">
        New
      </p>
      <h1 className="mt-1 text-2xl font-semibold">Add opportunity</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Direct opportunity creation. Select the account first, then
        fill in the deal details.
      </p>

      <OpportunityForm
        accounts={accounts}
        defaultAccountId={prefilledAccountId}
        contacts={contactsForAccount}
      />
    </div>
  );
}
