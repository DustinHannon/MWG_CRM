import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";

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
    .where(eq(crmAccounts.id, id))
    .limit(1);

  if (!account) notFound();
  if (!canViewAll && account.ownerId !== session.id) notFound();

  void (await import("@/lib/recent-views")).trackView(
    session.id,
    "account",
    account.id,
  );

  const [accountContacts, accountOpps] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, id)),
    db
      .select()
      .from(opportunities)
      .where(eq(opportunities.accountId, id)),
  ]);

  return (
    <div className="px-10 py-10">
      <Link
        href="/accounts"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to accounts
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{account.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {account.industry ?? "—"} · Owner {account.ownerName ?? "Unassigned"}
      </p>

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
