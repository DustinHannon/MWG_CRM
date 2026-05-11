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
import { UserTime } from "@/components/ui/user-time";
import { UserChip, UserHoverCard } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { canDeleteAccount } from "@/lib/access/can-delete";
import { listTasksForAccount } from "@/lib/tasks";
import { EntityTasksSection } from "@/components/tasks/entity-tasks-section";
import { AccountDetailDelete } from "../_components/account-detail-delete";

export const dynamic = "force-dynamic";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;
  const { id } = await params;

  const [account] = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      industry: crmAccounts.industry,
      website: crmAccounts.website,
      phone: crmAccounts.phone,
      city: crmAccounts.city,
      state: crmAccounts.state,
      country: crmAccounts.country,
      description: crmAccounts.description,
      ownerId: crmAccounts.ownerId,
      ownerName: users.displayName,
      createdAt: crmAccounts.createdAt,
    })
    .from(crmAccounts)
    .leftJoin(users, eq(users.id, crmAccounts.ownerId))
    .where(and(eq(crmAccounts.id, id), eq(crmAccounts.isDeleted, false)))
    .limit(1);

  if (!account) notFound();
  if (!canViewAll && account.ownerId !== session.id) notFound();

  void (await import("@/lib/recent-views")).trackView(
    session.id,
    "account",
    account.id,
  );

  // Phase 9C (workflow) — "Customer since" derives from the earliest
  // closed_won opportunity on this account. Cheap aggregate query
  // (one row, single index seek on opportunities_account_idx + filter
  // on stage); we deliberately keep this on the detail page only —
  // the listing page uses a per-row count column instead.
  const [accountContacts, accountOpps, customerSinceRow] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(and(eq(contacts.accountId, id), eq(contacts.isDeleted, false))),
    db
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.accountId, id),
          eq(opportunities.isDeleted, false),
        ),
      ),
    db
      .select({
        firstWonAt: sql<Date | null>`min(${opportunities.closedAt})`,
      })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.accountId, id),
          eq(opportunities.stage, "closed_won"),
          eq(opportunities.isDeleted, false),
        ),
      ),
  ]);

  const customerSince = customerSinceRow[0]?.firstWonAt ?? null;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Accounts", href: "/accounts" },
          { label: account.name },
        ]}
      />
      {/* Phase 12 — Supabase Realtime: focal record + filtered children. */}
      <RowRealtime entity="accounts" id={account.id} />
      <PageRealtime entities={["contacts", "opportunities"]} />
      <PageRealtime
        entities={["activities"]}
        filter={`account_id=eq.${account.id}`}
      />
      <PagePoll
        entities={["accounts", "contacts", "opportunities", "activities"]}
      />
      <Link
        href="/accounts"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to accounts
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{account.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{account.industry ?? "—"}</span>
            <span>·</span>
            <span>Owner</span>
            {/* Phase 9C — single low-cardinality chip on a detail page;
                include the server-rendered hover card. */}
            {account.ownerId ? (
              <UserChip
                size="md"
                user={{
                  id: account.ownerId,
                  displayName: account.ownerName,
                  photoUrl: null,
                }}
                hoverCard={<UserHoverCard userId={account.ownerId} />}
              />
            ) : (
              <span>Unassigned</span>
            )}
          </div>
          {customerSince ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Customer since{" "}
              <UserTime value={customerSince} mode="date" />
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/contacts/new?accountId=${account.id}`}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
          >
            + New contact
          </Link>
          <Link
            href={`/opportunities/new?accountId=${account.id}`}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            + New opportunity
          </Link>
          {canDeleteAccount(session, { ownerId: account.ownerId }) ? (
            <AccountDetailDelete
              accountId={account.id}
              accountName={account.name}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <GlassCard className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Details
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Website" value={account.website} />
            <Row label="Phone" value={account.phone} />
            <Row
              label="Location"
              value={
                [account.city, account.state, account.country]
                  .filter(Boolean)
                  .join(", ") || null
              }
            />
            <Row label="Description" value={account.description} />
          </dl>
        </GlassCard>

        <div className="space-y-6">
          <GlassCard className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Contacts ({accountContacts.length})
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {accountContacts.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/contacts/${c.id}`}
                    className="hover:underline"
                  >
                    {formatPersonName(c)}
                  </Link>
                  {c.jobTitle ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {c.jobTitle}
                    </span>
                  ) : null}
                </li>
              ))}
              {accountContacts.length === 0 ? (
                <li className="text-xs text-muted-foreground">No contacts.</li>
              ) : null}
            </ul>
          </GlassCard>

          <GlassCard className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Opportunities ({accountOpps.length})
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {accountOpps.map((o) => (
                <li key={o.id} className="flex items-center justify-between">
                  <Link
                    href={`/opportunities/${o.id}`}
                    className="hover:underline"
                  >
                    {o.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {o.stage} · ${Number(o.amount ?? 0).toLocaleString()}
                  </span>
                </li>
              ))}
              {accountOpps.length === 0 ? (
                <li className="text-xs text-muted-foreground">No opportunities.</li>
              ) : null}
            </ul>
          </GlassCard>

          {/* Phase 25 §7.3 — account-scoped Tasks section. Same
              EntityTasksSection used by /leads /contacts
              /opportunities; auto-FK to this account on quick-add. */}
          <GlassCard className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Tasks
            </h2>
            <div className="mt-3">
              <EntityTasksSection
                entityType="account"
                entityId={account.id}
                tasks={await listTasksForAccount(account.id)}
                currentUserId={session.id}
              />
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex">
      <dt className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}
