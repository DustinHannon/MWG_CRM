import Link from "next/link";
import { ChevronRight, Mail, Users, Send, Ban } from "lucide-react";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingLists } from "@/db/schema/marketing-lists";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Marketing overview. Counts surface scale at a glance and
 * link tiles route to the four sub-pages.
 */
export default async function MarketingOverviewPage() {
  const [templates, lists, campaigns, suppressions] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(marketingTemplates)
      .where(sql`is_deleted = false`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(marketingLists)
      .where(sql`is_deleted = false`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(marketingCampaigns)
      .where(sql`is_deleted = false`),
    db.select({ n: sql<number>`count(*)::int` }).from(marketingSuppressions),
  ]);

  const tiles: Array<{
    href: string;
    label: string;
    description: string;
    Icon: typeof Mail;
    count: number;
  }> = [
    {
      href: "/marketing/templates",
      label: "Templates",
      description: "Drag-and-drop email designs",
      Icon: Mail,
      count: templates[0]?.n ?? 0,
    },
    {
      href: "/marketing/lists",
      label: "Lists",
      description: "Recipient segments from your CRM",
      Icon: Users,
      count: lists[0]?.n ?? 0,
    },
    {
      href: "/marketing/campaigns",
      label: "Campaigns",
      description: "Compose, schedule, and send",
      Icon: Send,
      count: campaigns[0]?.n ?? 0,
    },
    {
      href: "/marketing/suppressions",
      label: "Suppressions",
      description: "Bounced, unsubscribed, blocked",
      Icon: Ban,
      count: suppressions[0]?.n ?? 0,
    },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.index()} />
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Marketing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build templates, segment recipients, and send campaigns.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(({ href, label, description, Icon, count }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition hover:border-foreground/30 hover:bg-accent/30"
          >
            <div className="flex items-center justify-between">
              <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
              <ChevronRight
                className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                aria-hidden
              />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">{label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {description}
              </div>
            </div>
            <div className="text-2xl font-semibold text-foreground">{count}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
