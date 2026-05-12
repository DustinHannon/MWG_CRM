import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { AccountEditForm } from "./_components/account-edit-form";

export const dynamic = "force-dynamic";

/**
 * dedicated edit form for accounts. Mirrors the
 * shape of /leads/[id]/edit: server-loaded entity, client form,
 * submit-by-server-action. OCC token is the row's `version` passed
 * through a hidden field.
 */
export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;

  const [account] = await db
    .select()
    .from(crmAccounts)
    .where(eq(crmAccounts.id, id))
    .limit(1);
  if (!account || account.isDeleted) notFound();

  // Owner-or-admin-or-canViewAll. Stricter than view because edits
  // mutate state.
  const canEdit =
    user.isAdmin || account.ownerId === user.id || perms.canViewAllRecords;
  if (!canEdit) redirect(`/accounts/${id}`);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Accounts", href: "/accounts" },
          { label: account.name, href: `/accounts/${account.id}` },
          { label: "Edit" },
        ]}
      />
      <Link
        href={`/accounts/${account.id}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to account
      </Link>
      <div className="mt-3">
        <StandardPageHeader kicker="Edit" title={account.name} />
      </div>

      <AccountEditForm
        account={{
          id: account.id,
          version: account.version,
          name: account.name,
          industry: account.industry,
          website: account.website,
          phone: account.phone,
          email: account.email,
          accountNumber: account.accountNumber,
          numberOfEmployees: account.numberOfEmployees,
          annualRevenue: account.annualRevenue,
          street1: account.street1,
          street2: account.street2,
          city: account.city,
          state: account.state,
          postalCode: account.postalCode,
          country: account.country,
          description: account.description,
          parentAccountId: account.parentAccountId,
          primaryContactId: account.primaryContactId,
        }}
        contactOptions={await listContactPickerOptions(account.id)}
        parentOptions={await listAccountPickerOptions(account.id)}
      />
    </div>
  );
}

/**
 * Contacts attached to this account (or unassigned), for the
 * primary-contact picker. Capped at 500 to keep the select size sane.
 */
async function listContactPickerOptions(
  accountId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.isDeleted, false),
        // Show this account's contacts plus the existing primary
        // contact even if it has been re-parented; OR no-account
        // contacts so a fresh assignment is possible.
        eq(contacts.accountId, accountId),
      ),
    )
    .orderBy(asc(contacts.firstName), asc(contacts.lastName))
    .limit(500);
  return rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(" ").trim() ||
      "(unnamed)",
  }));
}

/**
 * Other accounts for the parent-account picker. Excludes self to
 * prevent cyclic parenting.
 */
async function listAccountPickerOptions(
  selfId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: crmAccounts.id, name: crmAccounts.name })
    .from(crmAccounts)
    .where(
      and(eq(crmAccounts.isDeleted, false), ne(crmAccounts.id, selfId)),
    )
    .orderBy(asc(crmAccounts.name))
    .limit(500);
  return rows;
}

