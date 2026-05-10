import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

export default function NewCampaignPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <BreadcrumbsSetter crumbs={marketingCrumbs.campaignsNew()} />
      <Link
        href="/marketing/campaigns"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to campaigns
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">New campaign</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Composer + scheduler land in the next pass.
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          Composer coming next pass
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Schema, send pipeline, webhook reconcile, and suppression sync are
          live. The send-now / schedule wizard mounts here when the upstream
          template + list flows complete.
        </p>
      </div>
    </div>
  );
}
