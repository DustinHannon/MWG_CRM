import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { DangerSection } from "./danger-section";

export const dynamic = "force-dynamic";

export default function DataToolsPage() {
  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Data" },
        ]}
      />
      <StandardPageHeader
        title="Data tools"
        description={
          <>
            Destructive operations. Each one requires you to type the exact
            phrase shown to confirm. There is no undo. Every action is logged
            in <a href="/admin/audit" className="underline">the audit log</a>.
          </>
        }
      />

      <div className="mt-8 flex flex-col gap-6">
        <DangerSection
          title="Delete ALL leads"
          description="Removes every lead, every activity, every attachment, and every import history entry."
          phrase="DELETE ALL LEADS"
          actionId="leads"
        />
        <DangerSection
          title="Delete ALL activities"
          description="Wipes the activity timeline (notes, calls, tasks, emails, meetings) but keeps lead records."
          phrase="DELETE ALL ACTIVITIES"
          actionId="activities"
        />
        <DangerSection
          title="Delete ALL import history"
          description="Clears the import job history. Does not affect leads created by previous imports."
          phrase="DELETE ALL IMPORTS"
          actionId="imports"
        />
      </div>
    </div>
  );
}
