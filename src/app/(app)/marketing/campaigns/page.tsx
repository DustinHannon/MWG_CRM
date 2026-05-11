import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState, StandardPageHeader } from "@/components/standard";
import {
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Campaigns list. Read-only view. Send-flow / scheduler
 * implementation lands in the next pass.
 */
export default async function CampaignsPage() {
  const rows = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      scheduledFor: marketingCampaigns.scheduledFor,
      sentAt: marketingCampaigns.sentAt,
      totalRecipients: marketingCampaigns.totalRecipients,
      totalSent: marketingCampaigns.totalSent,
      totalOpened: marketingCampaigns.totalOpened,
      templateName: marketingTemplates.name,
      listName: marketingLists.name,
      createdByName: users.displayName,
      updatedAt: marketingCampaigns.updatedAt,
    })
    .from(marketingCampaigns)
    .leftJoin(marketingTemplates, eq(marketingTemplates.id, marketingCampaigns.templateId))
    .leftJoin(marketingLists, eq(marketingLists.id, marketingCampaigns.listId))
    .leftJoin(users, eq(users.id, marketingCampaigns.createdById))
    .where(and(eq(marketingCampaigns.isDeleted, false)))
    .orderBy(desc(marketingCampaigns.updatedAt))
    .limit(200);

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.campaignsIndex()} />
      <StandardPageHeader
        title="Campaigns"
        description="Sends of a template to a list. Schedule, send, and track."
        actions={
          <Link
            href="/marketing/campaigns/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
          >
            + New campaign
          </Link>
        }
      />

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No campaigns yet"
          description="Build a list and pick a template to launch your first campaign."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Name</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Template</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">List</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Sent</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Opens</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-accent/20">
                  <td className="px-4 py-3">
                    <Link
                      href={`/marketing/campaigns/${r.id}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.templateName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.listName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-foreground">{r.status}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.totalSent.toLocaleString()}
                    {r.totalRecipients > 0 ? (
                      <span className="text-xs">
                        {" "}
                        / {r.totalRecipients.toLocaleString()}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.totalOpened.toLocaleString()}
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
