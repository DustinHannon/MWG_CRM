import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { ListForm } from "../_components/list-form";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — New marketing list. Composes the filter-DSL builder with
 * a live-preview right rail and submits via the create action.
 */
export default function NewListPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsNew()} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">New list</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a recipient segment from your CRM leads.
        </p>
      </div>
      <ListForm mode="create" />
    </div>
  );
}
