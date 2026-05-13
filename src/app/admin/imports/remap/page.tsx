import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { requireAdmin } from "@/lib/auth-helpers";
import { RemapListClient } from "./_components/remap-list-client";

export const dynamic = "force-dynamic";

/**
 * Admin claim-and-remap tool for activities.imported_by_name.
 *
 * Imported D365 activities sometimes carry a "By: <name>" string that
 * didn't resolve to a CRM user at import time (former employee,
 * misspelling, system account). Those rows have userId=NULL and
 * importedByName=<string>. This page lets an admin walk the unique
 * names and remap each to an existing user — every matching activity
 * gets userId set + importedByName cleared, with a forensic audit row
 * per affected activity.
 */
export default async function ClaimAndRemapPage() {
  await requireAdmin();
  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Imports" },
          { label: "Imported-by remap" },
        ]}
      />
      <RemapListClient timePrefs={timePrefs} />
    </div>
  );
}
