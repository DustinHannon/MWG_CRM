import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { templateVisibilityWhere } from "@/lib/marketing/templates";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { CampaignWizard } from "../../new/_components/campaign-wizard";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Edit a draft campaign. Reuses the wizard component but
 * jumps the user straight to the schedule step (since template + list
 * are already chosen). Only `draft` campaigns are editable; any other
 * status renders a read-only notice with a link back to detail.
 */
export default async function EditCampaignPage({ params }: Props) {
  const { id } = await params;
  const user = await requireSession();

  const [campaign] = await db
    .select()
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.id, id),
        eq(marketingCampaigns.isDeleted, false),
      ),
    )
    .limit(1);
  if (!campaign) notFound();

  if (campaign.status !== "draft") {
    return (
      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={marketingCrumbs.campaignsEdit(campaign.name, campaign.id)}
        />
        <Link
          href={`/marketing/campaigns/${campaign.id}`}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to campaign
        </Link>
        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center">
          <p className="text-sm font-medium text-foreground">
            This campaign cannot be edited
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Only draft campaigns can be modified. Cancel the campaign first
            if you need to make changes.
          </p>
          <Link
            href={`/marketing/campaigns/${campaign.id}`}
            className="mt-4 inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            View campaign
          </Link>
        </div>
      </div>
    );
  }

  // Load the candidate templates + lists so the wizard can re-render
  // selection grids if the user wants to swap.
  //
  // visibility filter. Admin bypasses. We deliberately
  // include the campaign's currently-selected template_id in the
  // result even if the visibility filter would otherwise hide it:
  // the wizard needs to render that selection so the user can see
  // what they had picked before swapping.
  const visibility = user.isAdmin
    ? undefined
    : templateVisibilityWhere(user.id);
  const baseTemplateWhere = and(
    eq(marketingTemplates.isDeleted, false),
    eq(marketingTemplates.status, "ready"),
  );
  const templateWhere = visibility
    ? // Include the currently-selected template id even if the
      // visibility predicate would normally exclude it.
      and(
        baseTemplateWhere,
        campaign.templateId
          ? or(visibility, eq(marketingTemplates.id, campaign.templateId))
          : visibility,
      )
    : baseTemplateWhere;
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
    .where(templateWhere)
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

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={marketingCrumbs.campaignsEdit(campaign.name, campaign.id)}
      />
      <Link
        href={`/marketing/campaigns/${campaign.id}`}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to campaign
      </Link>
      <StandardPageHeader
        kicker="Edit campaign"
        title={campaign.name}
      />

      <CampaignWizard
        templates={templates}
        lists={lists}
        existing={{
          id: campaign.id,
          name: campaign.name,
          templateId: campaign.templateId,
          listId: campaign.listId,
          fromEmail: campaign.fromEmail,
          fromName: campaign.fromName,
          replyToEmail: campaign.replyToEmail,
          scheduledFor: campaign.scheduledFor
            ? campaign.scheduledFor.toISOString()
            : null,
          status: campaign.status,
          version: campaign.version,
        }}
        defaultListId={null}
        defaultTemplateId={null}
        defaultFromEmail={`noreply@${env.SENDGRID_FROM_DOMAIN}`}
        defaultFromName={env.SENDGRID_FROM_NAME_DEFAULT}
      />
    </div>
  );
}
