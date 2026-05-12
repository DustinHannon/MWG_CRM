import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
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
          description: account.description,
        }}
      />
    </div>
  );
}
