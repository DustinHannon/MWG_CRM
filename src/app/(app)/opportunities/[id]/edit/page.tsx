import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { TagSection } from "@/components/tags/tag-section";
import { OpportunityEditForm } from "./_components/opportunity-edit-form";

export const dynamic = "force-dynamic";

/**
 * dedicated edit form for opportunities.
 */
export default async function EditOpportunityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;

  const [opp] = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .limit(1);
  if (!opp || opp.isDeleted) notFound();

  const canEdit =
    user.isAdmin || opp.ownerId === user.id || perms.canViewAllRecords;
  if (!canEdit) redirect(`/opportunities/${id}`);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Opportunities", href: "/opportunities" },
          { label: opp.name, href: `/opportunities/${opp.id}` },
          { label: "Edit" },
        ]}
      />
      <Link
        href={`/opportunities/${opp.id}`}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← Back to opportunity
      </Link>
      <div className="mt-3">
        <StandardPageHeader kicker="Edit" title={opp.name} />
      </div>

      <OpportunityEditForm
        opportunity={{
          id: opp.id,
          version: opp.version,
          name: opp.name,
          stage: opp.stage,
          amount: opp.amount,
          expectedCloseDate: opp.expectedCloseDate,
          description: opp.description,
        }}
      />

      <div className="mt-8 max-w-2xl">
        <TagSection entityType="opportunity" entityId={opp.id} />
      </div>
    </div>
  );
}
