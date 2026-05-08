import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { GlassCard } from "@/components/ui/glass-card";
import { UserChip, UserHoverCard } from "@/components/user-display";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { canDeleteContact } from "@/lib/access/can-delete";
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
      accountId: contacts.accountId,
      accountName: crmAccounts.name,
      ownerId: contacts.ownerId,
      ownerName: users.displayName,
      doNotContact: contacts.doNotContact,
      doNotEmail: contacts.doNotEmail,
      doNotCall: contacts.doNotCall,
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
    <div className="px-10 py-10">
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
        {canDeleteContact(session, { ownerId: contact.ownerId }) ? (
          <ContactDetailDelete
            contactId={contact.id}
            contactName={formatPersonName(contact)}
          />
        ) : null}
      </div>

      <GlassCard className="mt-6 p-5">
        <dl className="space-y-2 text-sm">
          <Row label="Email" value={contact.email} mailto />
          <Row label="Phone" value={contact.phone} />
          <Row label="Mobile" value={contact.mobilePhone} />
          {/* Phase 9C — Owner row uses the canonical UserChip with a
              hover card on this single-record detail page. */}
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
            ]
              .filter(Boolean)
              .join(", ") || null}
          />
        </dl>
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
      <dd>
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
