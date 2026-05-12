import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { env } from "@/lib/env";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { CampaignWizard } from "./_components/campaign-wizard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    id?: string;
    listId?: string;
    templateId?: string;
  }>;
}

/**
 * Phase 21 — Campaign composer. Server-component shell that loads the
 * candidate templates + lists and any in-progress draft (when `?id=`
 * is present), then mounts the client-side wizard.
 *
 * Wizard state shape lives in the client component. This page only
 * does I/O.
 */
export default async function NewCampaignPage({ searchParams }: Props) {
  const sp = await searchParams;

  // Templates the user can pick — only "ready" status is sendable.
  const templates = await db
    .select({
      id: marketingTemplates.id,
      name: marketingTemplates.name,
      subject: marketingTemplates.subject,
      preheader: marketingTemplates.preheader,
      renderedHtml: marketingTemplates.renderedHtml,
      updatedAt: marketingTemplates.updatedAt,
    })
    .from(marketingTemplates)
    .where(
      and(
        eq(marketingTemplates.isDeleted, false),
        eq(marketingTemplates.status, "ready"),
      ),
    )
    .orderBy(desc(marketingTemplates.updatedAt))
    .limit(200);

  const lists = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      description: marketingLists.description,
      memberCount: marketingLists.memberCount,
      lastRefreshedAt: marketingLists.lastRefreshedAt,
    })
    .from(marketingLists)
    .where(eq(marketingLists.isDeleted, false))
    .orderBy(asc(marketingLists.name))
    .limit(500);

  // Resume an existing draft if `?id=` is present.
  let existing: typeof marketingCampaigns.$inferSelect | null = null;
  if (sp.id) {
    const [row] = await db
      .select()
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.id, sp.id),
          eq(marketingCampaigns.isDeleted, false),
        ),
      )
      .limit(1);
    existing = row ?? null;
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.campaignsNew()} />
      <StandardPageHeader
        kicker="New campaign"
        title={existing ? `Resume — ${existing.name}` : "Compose a new campaign"}
        description={
          <>
            Pick a template, choose your audience, set the schedule, then
            review and send. Each step saves a draft so you can come back later.
          </>
        }
      />

      <CampaignWizard
        templates={templates}
        lists={lists}
        existing={
          existing
            ? {
                id: existing.id,
                name: existing.name,
                templateId: existing.templateId,
                listId: existing.listId,
                fromEmail: existing.fromEmail,
                fromName: existing.fromName,
                replyToEmail: existing.replyToEmail,
                version: existing.version,
                scheduledFor: existing.scheduledFor
                  ? existing.scheduledFor.toISOString()
                  : null,
                status: existing.status,
              }
            : null
        }
        defaultListId={sp.listId ?? null}
        defaultTemplateId={sp.templateId ?? null}
        defaultFromEmail={`noreply@${env.SENDGRID_FROM_DOMAIN}`}
        defaultFromName={env.SENDGRID_FROM_NAME_DEFAULT}
      />
    </div>
  );
}
