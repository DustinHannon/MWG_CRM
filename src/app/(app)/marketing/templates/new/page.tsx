import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { NewTemplateForm } from "./_components/new-template-form";

export const dynamic = "force-dynamic";

/**
 * Phase 21 — Template create. The metadata (name, subject, preheader,
 * description) is captured here; the design itself lives on the next
 * step. The Unlayer editor mounts on the edit page once the row
 * exists so the lock infrastructure has a target id to talk to.
 */
export default function NewTemplatePage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.templatesNew()} />
      <Link
        href="/marketing/templates"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to templates
      </Link>

      <div>
        <h1 className="text-2xl font-semibold text-foreground">New template</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give the template a name and subject; the drag-and-drop editor
          opens after creation.
        </p>
      </div>

      <div className="max-w-2xl">
        <NewTemplateForm />
      </div>
    </div>
  );
}
