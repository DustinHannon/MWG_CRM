import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { RowRealtime } from "@/components/realtime/row-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { StatusPill } from "@/components/ui/status-pill";
import { UserTime } from "@/components/ui/user-time";
import { UserChip, UserHoverCard } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { canDeleteOpportunity } from "@/lib/access/can-delete";
import { listTasksForOpportunity } from "@/lib/tasks";
import { EntityTasksSection } from "@/components/tasks/entity-tasks-section";
import { OpportunityDetailDelete } from "../_components/opportunity-detail-delete";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;
  const { id } = await params;

  const [opp] = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      stage: sql<string>`${opportunities.stage}::text`,
      amount: opportunities.amount,
      probability: opportunities.probability,
      expectedCloseDate: opportunities.expectedCloseDate,
      description: opportunities.description,
      accountId: opportunities.accountId,
      accountName: crmAccounts.name,
      contactId: opportunities.primaryContactId,
      contactName: sql<string | null>`CASE WHEN ${contacts.id} IS NULL THEN NULL ELSE concat_ws(' ', ${contacts.firstName}, ${contacts.lastName}) END`,
      ownerId: opportunities.ownerId,
      ownerName: users.displayName,
      sourceLeadId: opportunities.sourceLeadId,
      createdAt: opportunities.createdAt,
    })
    .from(opportunities)
    .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .leftJoin(contacts, eq(contacts.id, opportunities.primaryContactId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(and(eq(opportunities.id, id), eq(opportunities.isDeleted, false)))
    .limit(1);

  if (!opp) notFound();
  if (!canViewAll && opp.ownerId !== session.id) notFound();

  void (await import("@/lib/recent-views")).trackView(
    session.id,
    "opportunity",
    opp.id,
  );

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Opportunities", href: "/opportunities" },
          { label: opp.name },
        ]}
      />
      {/* Phase 12 — Supabase Realtime: focal record + filtered children. */}
      <RowRealtime entity="opportunities" id={opp.id} />
      <PageRealtime
        entities={["activities"]}
        filter={`opportunity_id=eq.${opp.id}`}
      />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["opportunities", "activities", "tasks"]} />
      <Link
        href="/opportunities"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to opportunities
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{opp.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusPill status={opp.stage} />
            <span>
              {opp.amount ? `$${Number(opp.amount).toLocaleString()}` : "—"}
            </span>
            <span aria-hidden>·</span>
            <span>
              Expected close{" "}
              <UserTime value={opp.expectedCloseDate} mode="date" />
            </span>
          </div>
        </div>
        {canDeleteOpportunity(session, { ownerId: opp.ownerId }) ? (
          <OpportunityDetailDelete
            opportunityId={opp.id}
            opportunityName={opp.name}
          />
        ) : null}
      </div>

      <GlassCard className="mt-6 p-5">
        <dl className="space-y-2 text-sm">
          <Row
            label="Account"
            href={`/accounts/${opp.accountId}`}
            value={opp.accountName ?? null}
          />
          <Row
            label="Primary contact"
            href={opp.contactId ? `/contacts/${opp.contactId}` : null}
            value={opp.contactName ?? null}
          />
          {/* Phase 9C — Owner uses canonical UserChip + UserHoverCard
              on this single-record detail page. */}
          <div className="flex">
            <dt className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
              Owner
            </dt>
            <dd>
              {opp.ownerId ? (
                <UserChip
                  user={{
                    id: opp.ownerId,
                    displayName: opp.ownerName,
                    photoUrl: null,
                  }}
                  hoverCard={<UserHoverCard userId={opp.ownerId} />}
                />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <Row label="Probability" value={opp.probability ? `${opp.probability}%` : null} />
          <Row label="Description" value={opp.description ?? null} />
          {opp.sourceLeadId ? (
            <Row
              label="Originated from"
              href={`/leads/${opp.sourceLeadId}`}
              value="Source lead"
            />
          ) : null}
          <Row label="Created" value={<UserTime value={opp.createdAt} />} />
        </dl>
      </GlassCard>

      {/* Phase 25 §7.3 — opportunity-scoped Tasks section. Same
          EntityTasksSection used by /leads /accounts /contacts;
          auto-FK to this opportunity on quick-add. */}
      <GlassCard className="mt-6 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </h2>
        <div className="mt-3">
          <EntityTasksSection
            entityType="opportunity"
            entityId={opp.id}
            tasks={await listTasksForOpportunity(opp.id)}
            currentUserId={session.id}
          />
        </div>
      </GlassCard>
    </div>
  );
}

function Row({
  label,
  value,
  href,
}: {
  label: string;
  value: React.ReactNode | null;
  href?: string | null;
}) {
  return (
    <div className="flex">
      <dt className="w-40 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd>
        {value && href ? (
          <Link href={href} className="hover:underline">
            {value}
          </Link>
        ) : (
          (value ?? "—")
        )}
      </dd>
    </div>
  );
}
