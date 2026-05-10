import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Phase 19 — Template create. Stub form for the foundation pass; the
 * Unlayer drag-and-drop editor wires up in the next implementation
 * pass (deferred to Phase 19B per the project's tight delivery
 * boundary). For now, a marketing user can stage a template name +
 * subject + plain HTML body, then refine inside SendGrid until the
 * editor lands.
 */
export default function NewTemplatePage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/marketing/templates"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to templates
      </Link>

      <div>
        <h1 className="text-2xl font-semibold text-foreground">New template</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The drag-and-drop editor (Unlayer) lands in the next pass. For now,
          provision the template metadata via the admin debug API or import
          from SendGrid&apos;s console.
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          Editor coming next pass
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Schema, soft-lock infrastructure, and SendGrid sync are live. The
          embedded Unlayer editor mounts here once the foundation is verified
          in production.
        </p>
      </div>
    </div>
  );
}
