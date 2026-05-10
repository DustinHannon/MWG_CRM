import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";

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
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Campaigns</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sends of a template to a list. Schedule, send, and track.
          </p>
        </div>
        <Link
          href="/marketing/campaigns/new"
          className="inline-flex h-9 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90"
        >
          New campaign
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card text-center">
          <p className="text-sm font-medium text-foreground">
            No campaigns yet
          </p>
          <p className="text-xs text-muted-foreground">
            Build a list and pick a template to launch your first campaign.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Template</th>
                <th className="px-4 py-3 text-left font-medium">List</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Sent</th>
                <th className="px-4 py-3 text-left font-medium">Opens</th>
                <th className="px-4 py-3 text-left font-medium">Updated</th>
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
      )}
    </div>
  );
}
