import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { StaticListCreateForm } from "../../_components/static-list-create-form";

export const dynamic = "force-dynamic";

/**
 * Phase 29 §5 — Static-list creation entry point.
 *
 * Step 1: capture name + description and create the empty list row.
 * Step 2: redirect into the import wizard hosted at
 *         `/marketing/lists/<id>/import` (Sub-agent C).
 *
 * This page is intentionally minimal — the actual Excel/CSV ingest is
 * the wizard's job. A static list can also be filled via inline edit
 * on its detail page, so creating the empty list and going directly
 * to the detail view is also valid.
 */
export default function NewStaticListPage() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsNewStatic()} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <StandardPageHeader
        title="New static list"
        description="Imported recipients live outside the lead graph and are edited directly."
      />
      <StaticListCreateForm />
    </div>
  );
}
