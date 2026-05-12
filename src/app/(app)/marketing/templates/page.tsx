import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState, StandardPageHeader } from "@/components/standard";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { templateVisibilityWhere } from "@/lib/marketing/templates";

export const dynamic = "force-dynamic";

/**
 * Templates list. Read-only view of marketing_templates with
 * status pill, last-edited stamp, and creator. The drag-drop editor
 * (Unlayer) is mounted from /marketing/templates/[id] and
 * /marketing/templates/new — those routes are stubbed in subsequent
 * passes.
 *
 * Filters by visibility: global templates are visible to
 * everyone with template-view permissions; personal templates are
 * visible only to their creator. Admins bypass via the same query
 * shape — the visibility WHERE is composed in so admins still see
 * everything (no separate code path).
 */
export default async function TemplatesPage() {
  const user = await requireSession();

  // visibility filter. Admins bypass by skipping the
  // visibility predicate (they see all rows including others'
  // personal templates).
  const visibilityClause = user.isAdmin
    ? undefined
    : templateVisibilityWhere(user.id);

  const rows = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      subject: marketingTemplates.subject,
      status: marketingTemplates.status,
      scope: marketingTemplates.scope,
      updatedAt: marketingTemplates.updatedAt,
      createdAt: marketingTemplates.createdAt,
      createdById: marketingTemplates.createdById,
      createdByName: users.displayName,
    })
    .from(marketingTemplates)
    .leftJoin(users, eq(users.id, marketingTemplates.createdById))
    .where(
      visibilityClause
        ? and(eq(marketingTemplates.isDeleted, false), visibilityClause)
        : eq(marketingTemplates.isDeleted, false),
    )
    .orderBy(desc(marketingTemplates.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.templatesIndex()} />
      <StandardPageHeader
        title="Templates"
        description="Drag-and-drop email designs synced to SendGrid as Dynamic Templates."
        actions={
          <Link
            href="/marketing/templates/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            + New template
          </Link>
        }
      />

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No templates yet"
          description="Create your first template to start sending campaigns."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Subject</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Visibility</th>
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
                  <td className="px-4 py-3">
                    <ScopeBadge scope={r.scope} />
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

function ScopeBadge({ scope }: { scope: "global" | "personal" }) {
  // visibility marker. Neutral palette; the visibility
  // attribute is informational, not a status (status pill already
  // carries draft/ready/archived).
  const label = scope === "global" ? "Global" : "Personal";
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-scope={scope}
    >
      {label}
    </span>
  );
}
