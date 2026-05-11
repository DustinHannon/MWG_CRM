import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { requireSession } from "@/lib/auth-helpers";
import { AccountForm } from "./_components/account-form";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  await requireSession();

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Accounts", href: "/accounts" },
          { label: "New" },
        ]}
      />
      <Link
        href="/accounts"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to accounts
      </Link>
      <div className="mt-3">
        <StandardPageHeader
          kicker="New"
          title="Add account"
          description={
            <>
              Create an account directly. Lead conversion is the usual path —
              use this when you&apos;re starting from a known customer.
            </>
          }
        />
      </div>

      <AccountForm />
    </div>
  );
}
