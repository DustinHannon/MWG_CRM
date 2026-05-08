import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
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
      <p className="mt-3 text-xs uppercase tracking-[0.3em] text-muted-foreground/80">
        New
      </p>
      <h1 className="mt-1 text-2xl font-semibold">Add account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Create an account directly. Lead conversion is the usual path —
        use this when you&apos;re starting from a known customer.
      </p>

      <AccountForm />
    </div>
  );
}
