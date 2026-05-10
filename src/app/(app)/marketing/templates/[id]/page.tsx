import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Template detail. Shows metadata, status, SendGrid sync
 * state, and a preview of the rendered HTML. The Unlayer editor mount
 * lands here in the next pass.
 */
export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [row] = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      description: marketingTemplates.description,
      subject: marketingTemplates.subject,
      preheader: marketingTemplates.preheader,
      status: marketingTemplates.status,
      sendgridTemplateId: marketingTemplates.sendgridTemplateId,
      sendgridVersionId: marketingTemplates.sendgridVersionId,
      renderedHtml: marketingTemplates.renderedHtml,
      createdAt: marketingTemplates.createdAt,
      updatedAt: marketingTemplates.updatedAt,
      createdByName: users.displayName,
    })
    .from(marketingTemplates)
    .leftJoin(users, eq(users.id, marketingTemplates.createdById))
    .where(eq(marketingTemplates.id, id))
    .limit(1);

  if (!row) notFound();

  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/marketing/templates"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to templates
      </Link>

      <div>
        <h1 className="text-2xl font-semibold text-foreground">{row.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Subject: <span className="text-foreground">{row.subject}</span>
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Status
          </dt>
          <dd className="mt-1 text-sm font-medium text-foreground">
            {row.status}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            SendGrid template
          </dt>
          <dd className="mt-1 break-all text-sm text-foreground">
            {row.sendgridTemplateId ?? (
              <span className="text-muted-foreground">Not synced</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Last updated
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            <UserTime value={row.updatedAt} />
          </dd>
        </div>
      </dl>

      <div className="rounded-lg border border-border bg-card p-5">
        <p className="mb-3 text-xs uppercase tracking-[0.05em] text-muted-foreground">
          Preview
        </p>
        {row.renderedHtml ? (
          <iframe
            srcDoc={row.renderedHtml}
            sandbox=""
            className="h-[600px] w-full rounded border border-border bg-background"
            title={`${row.name} preview`}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No HTML rendered yet.</p>
        )}
      </div>
    </div>
  );
}
