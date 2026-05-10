import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Mail,
  MailWarning,
  MousePointerClick,
  Send,
  UserMinus,
  Users,
} from "lucide-react";
import { db } from "@/db";
import {
  campaignRecipients,
  marketingCampaigns,
} from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { UserTime } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { CampaignActions } from "./_components/campaign-actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    recipPage?: string;
    recipStatus?: string;
  }>;
}

const RECIPIENT_PAGE_SIZE = 50;

const RECIPIENT_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "dropped",
  "deferred",
  "blocked",
  "spamreport",
  "unsubscribed",
] as const;

export default async function CampaignDetailPage({
  params,
  searchParams,
}: Props) {
  const user = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  const [row] = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      templateId: marketingCampaigns.templateId,
      templateName: marketingTemplates.name,
      listId: marketingCampaigns.listId,
      listName: marketingLists.name,
      fromEmail: marketingCampaigns.fromEmail,
      fromName: marketingCampaigns.fromName,
      replyToEmail: marketingCampaigns.replyToEmail,
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
      createdAt: marketingCampaigns.createdAt,
      updatedAt: marketingCampaigns.updatedAt,
      createdByName: users.displayName,
      isDeleted: marketingCampaigns.isDeleted,
    })
    .from(marketingCampaigns)
    .leftJoin(
      marketingTemplates,
      eq(marketingTemplates.id, marketingCampaigns.templateId),
    )
    .leftJoin(
      marketingLists,
      eq(marketingLists.id, marketingCampaigns.listId),
    )
    .leftJoin(users, eq(users.id, marketingCampaigns.createdById))
    .where(eq(marketingCampaigns.id, id))
    .limit(1);

  if (!row || row.isDeleted) notFound();

  // Recipient pagination.
  const page = Math.max(1, Number(sp.recipPage ?? "1") || 1);
  const statusFilter =
    sp.recipStatus &&
    (RECIPIENT_STATUSES as readonly string[]).includes(sp.recipStatus)
      ? (sp.recipStatus as (typeof RECIPIENT_STATUSES)[number])
      : null;

  const recipientConditions = statusFilter
    ? and(
        eq(campaignRecipients.campaignId, row.id),
        eq(campaignRecipients.status, statusFilter),
      )
    : eq(campaignRecipients.campaignId, row.id);

  const recipientRows = await db
    .select({
      id: campaignRecipients.id,
      email: campaignRecipients.email,
      status: campaignRecipients.status,
      firstOpenedAt: campaignRecipients.firstOpenedAt,
      firstClickedAt: campaignRecipients.firstClickedAt,
      bounceReason: campaignRecipients.bounceReason,
    })
    .from(campaignRecipients)
    .where(recipientConditions)
    .limit(RECIPIENT_PAGE_SIZE)
    .offset((page - 1) * RECIPIENT_PAGE_SIZE);

  const [{ total: recipientTotal }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(recipientConditions);

  const totalPages = Math.max(
    1,
    Math.ceil(recipientTotal / RECIPIENT_PAGE_SIZE),
  );

  const isAdmin = user.isAdmin;
  const editable = row.status === "draft";
  const canSchedule = row.status === "draft";
  const canCancel = row.status === "draft" || row.status === "scheduled";
  const canSendNow = row.status === "draft" || row.status === "scheduled";
  const canDelete = row.status === "draft" || row.status === "cancelled";

  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.campaignsDetail(row.name)} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Campaign
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-foreground">
            {row.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={row.status} />
            {row.scheduledFor ? (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" aria-hidden />
                Scheduled for <UserTime value={row.scheduledFor} />
              </span>
            ) : null}
            {row.sentAt ? (
              <span className="inline-flex items-center gap-1">
                <Send className="h-3.5 w-3.5" aria-hidden />
                Sent <UserTime value={row.sentAt} />
              </span>
            ) : null}
            <span>
              Template:{" "}
              <Link
                href={`/marketing/templates/${row.templateId}`}
                className="text-foreground hover:underline"
              >
                {row.templateName ?? "—"}
              </Link>
            </span>
            <span>
              List:{" "}
              <Link
                href={`/marketing/lists/${row.listId}`}
                className="text-foreground hover:underline"
              >
                {row.listName ?? "—"}
              </Link>
            </span>
            <span>By {row.createdByName ?? "—"}</span>
          </div>
          {row.failureReason ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)]">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Send failed: {row.failureReason}
            </div>
          ) : null}
        </div>
        <CampaignActions
          campaignId={row.id}
          status={row.status}
          editable={editable}
          canSchedule={canSchedule}
          canCancel={canCancel}
          canSendNow={canSendNow}
          canDelete={canDelete}
          isAdmin={isAdmin}
        />
      </div>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
        <Counter
          icon={<Users className="h-4 w-4" />}
          label="Recipients"
          value={row.totalRecipients}
        />
        <Counter
          icon={<Send className="h-4 w-4" />}
          label="Sent"
          value={row.totalSent}
        />
        <Counter
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Delivered"
          value={row.totalDelivered}
        />
        <Counter
          icon={<Mail className="h-4 w-4" />}
          label="Opened"
          value={row.totalOpened}
        />
        <Counter
          icon={<MousePointerClick className="h-4 w-4" />}
          label="Clicked"
          value={row.totalClicked}
        />
        <Counter
          icon={<MailWarning className="h-4 w-4" />}
          label="Bounced"
          value={row.totalBounced}
          tone="destructive"
        />
        <Counter
          icon={<UserMinus className="h-4 w-4" />}
          label="Unsubscribed"
          value={row.totalUnsubscribed}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Recipients
          </h2>
          <RecipientFilters
            campaignId={row.id}
            currentStatus={statusFilter}
          />
        </div>
        {recipientRows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            {row.status === "draft" || row.status === "scheduled"
              ? "Recipients will appear here once the campaign starts sending."
              : "No recipients match this filter."}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Email</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Opened</th>
                  <th className="px-4 py-3 text-left font-medium">Clicked</th>
                  <th className="px-4 py-3 text-left font-medium">Bounce reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipientRows.map((r) => (
                  <tr key={r.id} className="transition hover:bg-accent/20">
                    <td className="px-4 py-3 text-foreground">{r.email}</td>
                    <td className="px-4 py-3">
                      <RecipientStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.firstOpenedAt ? (
                        <UserTime value={r.firstOpenedAt} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.firstClickedAt ? (
                        <UserTime value={r.firstClickedAt} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.bounceReason ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {recipientTotal.toLocaleString()}{" "}
              recipients
            </span>
            <div className="flex items-center gap-1">
              {page > 1 ? (
                <Link
                  href={recipPageHref(row.id, page - 1, statusFilter)}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
                >
                  Previous
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link
                  href={recipPageHref(row.id, page + 1, statusFilter)}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
                >
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function recipPageHref(
  campaignId: string,
  page: number,
  status: string | null,
): string {
  const sp = new URLSearchParams();
  sp.set("recipPage", String(page));
  if (status) sp.set("recipStatus", status);
  return `/marketing/campaigns/${campaignId}?${sp.toString()}`;
}

function StatusBadge({ status }: { status: string }) {
  const tone = campaignStatusTone(status);
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {status === "sending" ? (
        <Clock className="h-3 w-3 animate-spin" aria-hidden />
      ) : null}
      {label}
    </span>
  );
}

function campaignStatusTone(status: string): string {
  switch (status) {
    case "draft":
      return "border-border bg-muted text-muted-foreground";
    case "scheduled":
      return "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]";
    case "sending":
      return "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]";
    case "sent":
      return "border-[var(--status-qualified-fg)]/30 bg-[var(--status-qualified-bg)] text-[var(--status-qualified-fg)]";
    case "failed":
      return "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]";
    case "cancelled":
      return "border-border bg-muted text-muted-foreground/70";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function Counter({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "destructive";
}) {
  return (
    <div
      className={
        "rounded-2xl border bg-muted/40 p-4 " +
        (tone === "destructive"
          ? "border-[var(--status-lost-fg)]/30"
          : "border-border")
      }
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function RecipientStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-[0.05em] text-muted-foreground">
      {status}
    </span>
  );
}

function RecipientFilters({
  campaignId,
  currentStatus,
}: {
  campaignId: string;
  currentStatus: string | null;
}) {
  const make = (s: string | null): string => {
    const sp = new URLSearchParams();
    if (s) sp.set("recipStatus", s);
    sp.set("recipPage", "1");
    return `/marketing/campaigns/${campaignId}?${sp.toString()}`;
  };
  const options: { value: string | null; label: string }[] = [
    { value: null, label: "All" },
    { value: "delivered", label: "Delivered" },
    { value: "bounced", label: "Bounced" },
    { value: "unsubscribed", label: "Unsubscribed" },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {options.map((o) => {
        const active =
          (o.value === null && currentStatus === null) ||
          o.value === currentStatus;
        return (
          <Link
            key={o.label}
            href={make(o.value)}
            className={
              "rounded-full border px-2.5 py-0.5 text-xs transition " +
              (active
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-muted")
            }
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}
