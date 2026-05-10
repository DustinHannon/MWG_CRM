import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Templates list. Read-only view of marketing_templates with
 * status pill, last-edited stamp, and creator. The drag-drop editor
 * (Unlayer) is mounted from /marketing/templates/[id] and
 * /marketing/templates/new — those routes are stubbed in subsequent
 * passes.
 */
export default async function TemplatesPage() {
  const rows = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      subject: marketingTemplates.subject,
      status: marketingTemplates.status,
      updatedAt: marketingTemplates.updatedAt,
      createdAt: marketingTemplates.createdAt,
      createdByName: users.displayName,
    })
    .from(marketingTemplates)
    .leftJoin(users, eq(users.id, marketingTemplates.createdById))
    .where(and(eq(marketingTemplates.isDeleted, false)))
    .orderBy(desc(marketingTemplates.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.templatesIndex()} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag-and-drop email designs synced to SendGrid as Dynamic Templates.
          </p>
        </div>
        <Link
          href="/marketing/templates/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
        >
          + New template
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card text-center">
          <p className="text-sm font-medium text-foreground">
            No templates yet
          </p>
          <p className="text-xs text-muted-foreground">
            Create your first template to start sending campaigns.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Subject</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Created by</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="transition hover:bg-accent/20"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/marketing/templates/${r.id}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.subject}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.createdByName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "draft" | "ready" | "archived" }) {
  const label =
    status === "draft" ? "Draft" : status === "ready" ? "Ready" : "Archived";
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-status={status}
    >
      {label}
    </span>
  );
}
