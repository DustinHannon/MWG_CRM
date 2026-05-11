import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { getLeadById } from "@/lib/leads";
import { getTagsForLead } from "@/lib/tags";
import { formatPersonName } from "@/lib/format/person-name";
import { LeadForm } from "../../lead-form";

export const dynamic = "force-dynamic";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canEditLeads) {
    redirect("/leads");
  }
  const { id } = await params;
  const lead = await getLeadById(user, id, perms.canViewAllRecords);
  if (!lead) notFound();

  // Phase 8D Wave 6 (FIX-016) — fetch tag rows (id+name+color) to seed
  // the TagInput combobox. getLeadById hydrates `lead.tags` as a string
  // array of names only, which the combobox can't render as chips.
  const tagRows = await getTagsForLead(lead.id);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Leads", href: "/leads" },
          { label: formatPersonName(lead), href: `/leads/${lead.id}` },
          { label: "Edit" },
        ]}
      />
      <Link
        href={`/leads/${lead.id}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to lead
      </Link>
      <p className="mt-3 text-xs uppercase tracking-[0.3em] text-muted-foreground/80">Edit</p>
      <h1 className="mt-1 text-2xl font-semibold">{formatPersonName(lead)}</h1>

      <LeadForm
        mode="edit"
        lead={{
          id: lead.id,
          version: lead.version,
          salutation: lead.salutation,
          firstName: lead.firstName,
          lastName: lead.lastName,
          jobTitle: lead.jobTitle,
          companyName: lead.companyName,
          industry: lead.industry,
          email: lead.email,
          phone: lead.phone,
          mobilePhone: lead.mobilePhone,
          website: lead.website,
          linkedinUrl: lead.linkedinUrl,
          street1: lead.street1,
          street2: lead.street2,
          city: lead.city,
          state: lead.state,
          postalCode: lead.postalCode,
          country: lead.country,
          description: lead.description,
          subject: lead.subject,
          status: lead.status,
          rating: lead.rating,
          source: lead.source,
          estimatedValue: lead.estimatedValue,
          estimatedCloseDate: lead.estimatedCloseDate,
          doNotContact: lead.doNotContact,
          doNotEmail: lead.doNotEmail,
          doNotCall: lead.doNotCall,
          tags: tagRows.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }}
      />
    </div>
  );
}
