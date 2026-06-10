import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import {
  MarketingEmailReport,
  type MarketingReportRow,
} from "@/components/marketing/marketing-email-report";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    from?: string;
    to?: string;
  }>;
}

/**
 * Marketing Email Performance report.
 *
 * Standalone page (not wired into the reports registry) — the
 * registry's entityType enum is locked to a finite list of CRM entities
 * and `marketing_campaign` would require a schema-level extension. The
 * audit subtab links here.
 *
 * Window defaults to last 30 days; users can override via `?from=` /
 * `?to=` query params.
 */
export default async function MarketingEmailReportPage({ searchParams }: Props) {
  // Gate on the report-view permission. The layout only checks for ANY
  // marketing-view permission, so without this a user holding an unrelated
  // marketing-view grant could read campaign-performance data. Mirrors the
  // export route, which restricts the same dataset to canMarketingReportsView.
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingReportsView) {
    redirect("/marketing");
  }

  const sp = await searchParams;
  const prefs = await getCurrentUserTimePrefs();

  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Guard against unparseable query params (stale bookmark, crafted value):
  // an Invalid Date would propagate into the `gte` predicate and throw
  // `RangeError: Invalid time value` from `fromDate.toISOString()` below,
  // crashing the server render. Fall back to the default window, mirroring
  // the export route's NaN guard.
  const fromDate =
    sp.from && !Number.isNaN(new Date(sp.from).getTime())
      ? new Date(sp.from)
      : thirtyDaysAgo;
  const toDate =
    sp.to && !Number.isNaN(new Date(sp.to).getTime())
      ? new Date(sp.to)
      : today;
  // Push toDate to end-of-day to be inclusive.
  const toDateEnd = new Date(toDate);
  toDateEnd.setHours(23, 59, 59, 999);

  const rows = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      sentAt: marketingCampaigns.sentAt,
      totalRecipients: marketingCampaigns.totalRecipients,
      totalSent: marketingCampaigns.totalSent,
      totalDelivered: marketingCampaigns.totalDelivered,
      totalOpened: marketingCampaigns.totalOpened,
      totalClicked: marketingCampaigns.totalClicked,
      totalBounced: marketingCampaigns.totalBounced,
      totalUnsubscribed: marketingCampaigns.totalUnsubscribed,
    })
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.isDeleted, false),
        gte(marketingCampaigns.sentAt, fromDate),
        lte(marketingCampaigns.sentAt, toDateEnd),
      ),
    )
    .orderBy(desc(marketingCampaigns.sentAt))
    .limit(500);

  const reportRows: MarketingReportRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    sentAt: r.sentAt,
    totalRecipients: r.totalRecipients,
    totalSent: r.totalSent,
    totalDelivered: r.totalDelivered,
    totalOpened: r.totalOpened,
    totalClicked: r.totalClicked,
    totalBounced: r.totalBounced,
    totalUnsubscribed: r.totalUnsubscribed,
  }));

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Marketing", href: "/marketing" },
          { label: "Reports", href: "/marketing/reports/email" },
          { label: "Email performance" },
        ]}
      />
      <Link
        href="/marketing"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to marketing
      </Link>
      <StandardPageHeader
        kicker="Marketing report"
        title="Email performance"
        description={
          <>
            Aggregate open/click/bounce rates across every campaign sent in the
            window. Drill into any campaign for the recipient roster.
          </>
        }
      />
      <MarketingEmailReport
        rows={reportRows}
        prefs={prefs}
        defaultFrom={fromDate.toISOString().slice(0, 10)}
        defaultTo={toDate.toISOString().slice(0, 10)}
      />
    </div>
  );
}
