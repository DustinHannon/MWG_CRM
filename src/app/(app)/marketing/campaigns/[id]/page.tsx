import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [row] = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      scheduledFor: marketingCampaigns.scheduledFor,
      sentAt: marketingCampaigns.sentAt,
      totalRecipients: marketingCampaigns.totalRecipients,
      totalSent: marketingCampaigns.totalSent,
      totalDelivered: marketingCampaigns.totalDelivered,
      totalOpened: marketingCampaigns.totalOpened,
      totalClicked: marketingCampaigns.totalClicked,
      totalBounced: marketingCampaigns.totalBounced,
      totalUnsubscribed: marketingCampaigns.totalUnsubscribed,
      failureReason: marketingCampaigns.failureReason,
      fromEmail: marketingCampaigns.fromEmail,
      fromName: marketingCampaigns.fromName,
      templateName: marketingTemplates.name,
      listName: marketingLists.name,
      createdByName: users.displayName,
      updatedAt: marketingCampaigns.updatedAt,
    })
    .from(marketingCampaigns)
    .leftJoin(marketingTemplates, eq(marketingTemplates.id, marketingCampaigns.templateId))
    .leftJoin(marketingLists, eq(marketingLists.id, marketingCampaigns.listId))
    .leftJoin(users, eq(users.id, marketingCampaigns.createdById))
    .where(eq(marketingCampaigns.id, id))
    .limit(1);

  if (!row) notFound();

  const stats: Array<{ label: string; value: number }> = [
    { label: "Recipients", value: row.totalRecipients },
    { label: "Sent", value: row.totalSent },
    { label: "Delivered", value: row.totalDelivered },
    { label: "Opens", value: row.totalOpened },
    { label: "Clicks", value: row.totalClicked },
    { label: "Bounces", value: row.totalBounced },
    { label: "Unsubs", value: row.totalUnsubscribed },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/marketing/campaigns"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to campaigns
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{row.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {row.status} · From {row.fromName} &lt;{row.fromEmail}&gt; · Template{" "}
          {row.templateName ?? "—"} · List {row.listName ?? "—"}
        </p>
      </div>

      {row.failureReason ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failure: {row.failureReason}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
              {s.label}
            </div>
            <div className="mt-1 text-2xl font-semibold text-foreground">
              {s.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Scheduled
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {row.scheduledFor ? <UserTime value={row.scheduledFor} /> : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Sent at
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {row.sentAt ? <UserTime value={row.sentAt} /> : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
            Created by
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {row.createdByName ?? "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
