import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listAccountsForPicker } from "@/lib/accounts";
import { ContactForm } from "./_components/contact-form";

export const dynamic = "force-dynamic";

export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const accounts = await listAccountsForPicker(session.id, canViewAll);

  // Validate the prefill if present so a bad query string doesn't
  // poison the select. Falls back to "no account" otherwise.
  const prefilledAccountId =
    sp.accountId && accounts.some((a) => a.id === sp.accountId)
      ? sp.accountId
      : null;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: "New" },
        ]}
      />
      <Link
        href={prefilledAccountId ? `/accounts/${prefilledAccountId}` : "/contacts"}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {prefilledAccountId ? "← Back to account" : "← Back to contacts"}
      </Link>
      <div className="mt-3">
        <StandardPageHeader
          kicker="New"
          title="Add contact"
          description={
            <>
              Pick an account to attach this contact to, or leave it blank.
            </>
          }
        />
      </div>

      <ContactForm
        accounts={accounts}
        defaultAccountId={prefilledAccountId}
      />
    </div>
  );
}
