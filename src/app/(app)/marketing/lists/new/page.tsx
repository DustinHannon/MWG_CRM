import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { ListForm } from "../_components/list-form";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

/**
 * Dynamic-list builder.
 *
 * `?type` is accepted for future expansion; the only value
 * routed here is 'dynamic'. Static-list creation lives at
 * `/marketing/lists/new/import` (Sub-agent C).
 */
export default function NewListPage() {
  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.listsNewDynamic()} />
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <StandardPageHeader
        title="New dynamic list"
        description="Recipients are computed from a filter against the source entity."
      />
      <ListForm mode="create" />
    </div>
  );
}
