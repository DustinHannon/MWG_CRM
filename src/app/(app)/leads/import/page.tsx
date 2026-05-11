import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { ImportClient } from "./import-client";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canImport) {
    redirect("/leads");
  }

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: "Import" },
        ]}
      />
      <StandardPageHeader
        kicker="Import"
        title="Import leads from XLSX"
        description={
          <>
            Download the template, fill it in, and upload it back. Existing leads
            with a matching <code className="text-foreground/90">External ID</code>{" "}
            are updated. Rows with an email matching an existing lead are flagged
            for review (not auto-merged).
          </>
        }
      />

      <div className="mt-6 flex gap-3">
        <a
          href="/api/leads/import-template"
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted"
        >
          Download template
        </a>
      </div>

      <ImportClient />
    </div>
  );
}
