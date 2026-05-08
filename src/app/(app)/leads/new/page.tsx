import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { LeadForm } from "../lead-form";

export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canCreateLeads) {
    redirect("/leads");
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: "New" },
        ]}
      />
      <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground/80">New</p>
      <h1 className="mt-1 text-2xl font-semibold">Add lead</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Required fields are marked with an asterisk. Most fields are
        optional — fill them in as you learn more about the lead.
      </p>

      <LeadForm mode="create" />
    </div>
  );
}
