import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { ListForm } from "../_components/list-form";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — New marketing list. Composes the filter-DSL builder with
 * a live-preview right rail and submits via the create action.
 */
export default function NewListPage() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsNew()} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <StandardPageHeader
        title="New list"
        description="Build a recipient segment from your CRM leads."
      />
      <ListForm mode="create" />
    </div>
  );
}
