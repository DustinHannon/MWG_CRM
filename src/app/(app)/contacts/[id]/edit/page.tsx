import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { ContactEditForm } from "./_components/contact-edit-form";

export const dynamic = "force-dynamic";

/**
 * dedicated edit form for contacts.
 */
export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);
  if (!contact || contact.isDeleted) notFound();

  const canEdit =
    user.isAdmin || contact.ownerId === user.id || perms.canViewAllRecords;
  if (!canEdit) redirect(`/contacts/${id}`);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Contacts", href: "/contacts" },
          { label: formatPersonName(contact), href: `/contacts/${contact.id}` },
          { label: "Edit" },
        ]}
      />
      <Link
        href={`/contacts/${contact.id}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to contact
      </Link>
      <div className="mt-3">
        <StandardPageHeader kicker="Edit" title={formatPersonName(contact)} />
      </div>

      <ContactEditForm
        contact={{
          id: contact.id,
          version: contact.version,
          firstName: contact.firstName,
          lastName: contact.lastName,
          jobTitle: contact.jobTitle,
          email: contact.email,
          phone: contact.phone,
          mobilePhone: contact.mobilePhone,
          description: contact.description,
          street1: contact.street1,
          street2: contact.street2,
          city: contact.city,
          state: contact.state,
          postalCode: contact.postalCode,
          country: contact.country,
          birthdate: contact.birthdate ?? null,
          doNotEmail: contact.doNotEmail,
          doNotCall: contact.doNotCall,
          doNotMail: contact.doNotMail,
        }}
      />
    </div>
  );
}
