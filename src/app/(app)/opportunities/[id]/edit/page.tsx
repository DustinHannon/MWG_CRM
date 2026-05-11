import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { OpportunityEditForm } from "./_components/opportunity-edit-form";

export const dynamic = "force-dynamic";

/**
 * Phase 25 §7.4 — dedicated edit form for opportunities.
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
      <p className="mt-3 text-xs uppercase tracking-[0.3em] text-muted-foreground/80">
        Edit
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{opp.name}</h1>

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
    </div>
  );
}
