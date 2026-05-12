import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { RowRealtime } from "@/components/realtime/row-realtime";
import { GlassCard } from "@/components/ui/glass-card";
import { UserChip, UserHoverCard } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { canDeleteContact } from "@/lib/access/can-delete";
import { listTasksForContact } from "@/lib/tasks";
import { EntityTasksSection } from "@/components/tasks/entity-tasks-section";
import { ContactDetailDelete } from "../_components/contact-detail-delete";

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;
  const { id } = await params;

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      jobTitle: contacts.jobTitle,
      email: contacts.email,
      phone: contacts.phone,
      mobilePhone: contacts.mobilePhone,
      description: contacts.description,
      birthdate: contacts.birthdate,
      street1: contacts.street1,
      street2: contacts.street2,
      city: contacts.city,
      state: contacts.state,
      postalCode: contacts.postalCode,
      country: contacts.country,
      accountId: contacts.accountId,
      accountName: crmAccounts.name,
      ownerId: contacts.ownerId,
      ownerName: users.displayName,
      doNotContact: contacts.doNotContact,
      doNotEmail: contacts.doNotEmail,
      doNotCall: contacts.doNotCall,
      doNotMail: contacts.doNotMail,
      d365StateCode: contacts.d365StateCode,
    })
    .from(contacts)
    .leftJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(eq(contacts.id, id), eq(contacts.isDeleted, false)))
    .limit(1);

  if (!contact) notFound();
  if (!canViewAll && contact.ownerId !== session.id) notFound();

  void (await import("@/lib/recent-views")).trackView(
    session.id,
    "contact",
    contact.id,
  );

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: formatPersonName(contact) },
        ]}
      />
      {/* Supabase Realtime: focal record + filtered activities. */}
      <RowRealtime entity="contacts" id={contact.id} />
      <PageRealtime
        entities={["activities"]}
        filter={`contact_id=eq.${contact.id}`}
      />
      <PagePoll entities={["contacts"]} />
      <Link
        href="/contacts"
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to contacts
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {formatPersonName(contact)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {contact.jobTitle ? `${contact.jobTitle} · ` : ""}
            {contact.accountName ? (
              <Link href={`/accounts/${contact.accountId}`} className="hover:underline">
                {contact.accountName}
              </Link>
            ) : (
              "No account"
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {/* dedicated edit affordance. */}
          {session.isAdmin || contact.ownerId === session.id ? (
            <Link
              href={`/contacts/${contact.id}/edit`}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted"
            >
              Edit
            </Link>
          ) : null}
          {canDeleteContact(session, { ownerId: contact.ownerId }) ? (
            <ContactDetailDelete
              contactId={contact.id}
              contactName={formatPersonName(contact)}
            />
          ) : null}
        </div>
      </div>

      <GlassCard className="mt-6 p-5">
        <dl className="space-y-2 text-sm">
          <Row label="Email" value={contact.email} mailto />
          <Row label="Phone" value={contact.phone} />
          <Row label="Mobile" value={contact.mobilePhone} />
          <Row label="Birthdate" value={contact.birthdate ?? null} />
          <Row label="Address" value={formatAddress(contact)} />
          <div className="flex">
            <dt className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
              Owner
            </dt>
            <dd>
              {contact.ownerId ? (
                <UserChip
                  user={{
                    id: contact.ownerId,
                    displayName: contact.ownerName,
                    photoUrl: null,
                  }}
                  hoverCard={<UserHoverCard userId={contact.ownerId} />}
                />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <Row
            label="Preferences"
            value={[
              contact.doNotContact ? "Do not contact" : null,
              contact.doNotEmail ? "Do not email" : null,
              contact.doNotCall ? "Do not call" : null,
              contact.doNotMail ? "Do not postal mail" : null,
            ]
              .filter(Boolean)
              .join(", ") || null}
          />
          {contact.description ? (
            <Row label="Description" value={contact.description} />
          ) : null}
        </dl>
      </GlassCard>

      {/* contact-scoped Tasks section. Same
          EntityTasksSection used by /leads /accounts /opportunities;
          auto-FK to this contact on quick-add. */}
      <GlassCard className="mt-6 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Tasks
        </h2>
        <div className="mt-3">
          <EntityTasksSection
            entityType="contact"
            entityId={contact.id}
            tasks={await listTasksForContact(contact.id)}
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
  mailto,
}: {
  label: string;
  value: string | null;
  mailto?: boolean;
}) {
  return (
    <div className="flex">
      <dt className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="whitespace-pre-line">
        {mailto && value ? (
          <a href={`mailto:${value}`} className="hover:underline">
            {value}
          </a>
        ) : (
          (value ?? "—")
        )}
      </dd>
    </div>
  );
}

function formatAddress(contact: {
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}): string | null {
  const lines: string[] = [];
  if (contact.street1) lines.push(contact.street1);
  if (contact.street2) lines.push(contact.street2);
  const cityLine = [
    contact.city,
    [contact.state, contact.postalCode].filter(Boolean).join(" "),
  ]
    .filter((s) => s && s.length > 0)
    .join(", ");
  if (cityLine) lines.push(cityLine);
  if (contact.country) lines.push(contact.country);
  return lines.length > 0 ? lines.join("\n") : null;
}
