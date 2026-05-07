import { notFound, redirect } from "next/navigation";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { getLeadById } from "@/lib/leads";
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

  return (
    <div className="px-10 py-10">
      <p className="text-xs uppercase tracking-[0.3em] text-white/40">Edit</p>
      <h1 className="mt-1 text-2xl font-semibold">
        {lead.firstName} {lead.lastName}
      </h1>

      <LeadForm
        mode="edit"
        lead={{
          id: lead.id,
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
          status: lead.status,
          rating: lead.rating,
          source: lead.source,
          estimatedValue: lead.estimatedValue,
          estimatedCloseDate: lead.estimatedCloseDate,
          doNotContact: lead.doNotContact,
          doNotEmail: lead.doNotEmail,
          doNotCall: lead.doNotCall,
          tags: lead.tags ? lead.tags.join(", ") : "",
        }}
      />
    </div>
  );
}
