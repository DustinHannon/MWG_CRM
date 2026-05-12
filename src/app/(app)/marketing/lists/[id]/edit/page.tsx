import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import type { FilterDsl } from "@/lib/security/filter-dsl";
import { ListForm } from "../../_components/list-form";

export const dynamic = "force-dynamic";

/**
 * Phase 21 / Phase 29 §5 — Edit a marketing list (dynamic only).
 *
 * Loads the existing record and pre-populates the same form used by
 * /marketing/lists/new. Static-imported lists do not surface this
 * edit page; the detail page is the canonical editor for them.
 */
export default async function EditListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [row] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      description: marketingLists.description,
      filterDsl: marketingLists.filterDsl,
      listType: marketingLists.listType,
      sourceEntity: marketingLists.sourceEntity,
      isDeleted: marketingLists.isDeleted,
      version: marketingLists.version,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, id))
    .limit(1);
  if (!row || row.isDeleted) notFound();
  // Static lists are edited from their detail page.
  if (row.listType === "static_imported") {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={marketingCrumbs.listsEdit(row.name, row.id)}
      />
      <Link
        href={`/marketing/lists/${row.id}`}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to list
      </Link>
      <StandardPageHeader
        title="Edit list"
        description="Saving recomputes membership against the latest leads."
      />
      <ListForm
        mode="edit"
        initial={{
          id: row.id,
          name: row.name,
          description: row.description,
          filterDsl: row.filterDsl as FilterDsl,
          version: row.version,
          sourceEntity: row.sourceEntity,
        }}
      />
    </div>
  );
}
