import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default function NewListPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/marketing/lists"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to lists
      </Link>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">New list</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Filter-DSL builder lands in the next pass.
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          Filter builder coming next pass
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Phase 19 foundation provisions schema, refresh logic surface, and
          API endpoints. The drag-to-build filter UI mounts here when the
          first SendGrid → CRM round-trip is verified in production.
        </p>
      </div>
    </div>
  );
}
