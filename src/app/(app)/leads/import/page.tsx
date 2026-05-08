import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
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
    <div className="px-10 py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: "Import" },
        ]}
      />
      <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground/80">Import</p>
      <h1 className="mt-1 text-2xl font-semibold">Import leads from XLSX</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Download the template, fill it in, and upload it back. Existing leads
        with a matching <code className="text-foreground/90">External ID</code>{" "}
        are updated. Rows with an email matching an existing lead are flagged
        for review (not auto-merged).
      </p>

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
