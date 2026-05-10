import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { SafeHtmlPreview } from "@/components/security/safe-html-preview";
import { UserTime } from "@/components/ui/user-time";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { getLock } from "@/lib/marketing/template-lock";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — Template detail (read-only). Renders metadata, status,
 * SendGrid sync state, and a sandboxed preview of the rendered HTML.
 *
 * The Edit button shows when the user has marketing permission and no
 * other editor currently holds the soft-lock.
 */
export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;

  const [row] = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      description: marketingTemplates.description,
      subject: marketingTemplates.subject,
      preheader: marketingTemplates.preheader,
      renderedHtml: marketingTemplates.renderedHtml,
      status: marketingTemplates.status,
      sendgridTemplateId: marketingTemplates.sendgridTemplateId,
      sendgridVersionId: marketingTemplates.sendgridVersionId,
      createdAt: marketingTemplates.createdAt,
      updatedAt: marketingTemplates.updatedAt,
      version: marketingTemplates.version,
      createdByName: users.displayName,
    })
    .from(marketingTemplates)
    .leftJoin(users, eq(users.id, marketingTemplates.createdById))
    .where(
      and(
        eq(marketingTemplates.id, id),
        eq(marketingTemplates.isDeleted, false),
      ),
    )
    .limit(1);
  if (!row) notFound();

  const lock = await getLock(row.id);
  const lockedByOther = lock !== null && lock.userId !== user.id;
  const canEdit = (user.isAdmin || perms.canManageMarketing) && !lockedByOther;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.templatesDetail(row.name)} />

      <Link
        href="/marketing/templates"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to templates
      </Link>

      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{row.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{row.subject}</p>
          {row.preheader ? (
            <p className="mt-0.5 text-xs italic text-muted-foreground/80">
              {row.preheader}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canEdit ? (
            <Link
              href={`/marketing/templates/${row.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 whitespace-nowrap transition hover:bg-muted"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
            </Link>
          ) : null}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Preview
            </h2>
            <span className="text-xs text-muted-foreground/80">Sandboxed</span>
          </header>
          <div className="h-[600px] w-full">
            {row.renderedHtml ? (
              <SafeHtmlPreview
                html={row.renderedHtml}
                title={`Preview of ${row.name}`}
                className="h-full w-full bg-white"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  This template has no design yet. Open the editor to start
                  composing.
                </p>
              </div>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <SidebarBlock title="Status">
            <StatusPillLocal status={row.status} />
          </SidebarBlock>
          <SidebarBlock title="Created by">
            <p className="text-sm text-foreground/90">
              {row.createdByName ?? "Deleted user"}
            </p>
            <p className="text-xs text-muted-foreground">
              <UserTime value={row.createdAt} />
            </p>
          </SidebarBlock>
          <SidebarBlock title="Updated">
            <p className="text-sm text-foreground/90">
              <UserTime value={row.updatedAt} />
            </p>
            <p className="text-xs text-muted-foreground">
              Version {row.version}
            </p>
          </SidebarBlock>
          {row.sendgridTemplateId ? (
            <SidebarBlock title="SendGrid">
              <p className="break-all text-xs text-muted-foreground">
                Template:{" "}
                <code className="text-foreground/90">
                  {row.sendgridTemplateId}
                </code>
              </p>
              {row.sendgridVersionId ? (
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  Version:{" "}
                  <code className="text-foreground/90">
                    {row.sendgridVersionId}
                  </code>
                </p>
              ) : null}
            </SidebarBlock>
          ) : null}
          {lockedByOther && lock ? (
            <SidebarBlock title="Editing">
              <p className="text-sm text-foreground/90">{lock.userName}</p>
              <p className="text-xs text-muted-foreground">
                is currently editing this template.
              </p>
            </SidebarBlock>
          ) : null}
          {row.description ? (
            <SidebarBlock title="Description">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {row.description}
              </p>
            </SidebarBlock>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function SidebarBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function StatusPillLocal({
  status,
}: {
  status: "draft" | "ready" | "archived";
}) {
  const className =
    status === "ready"
      ? "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]"
      : status === "archived"
        ? "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
        : "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  const label =
    status === "ready" ? "Ready" : status === "archived" ? "Archived" : "Draft";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
