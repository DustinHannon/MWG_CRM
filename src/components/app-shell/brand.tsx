import Link from "next/link";

/**
 * Brand header at the top of the sidebar. Renders
 *   MORGAN WHITE GROUP
 *   MWG CRM[ <subtitle>]
 *
 * The subtitle preserves the historical "MWG CRM Admin" treatment used
 * by the admin section; defaults to no subtitle for the main app.
 */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="px-5 py-6">
      <Link href="/dashboard" className="block">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Morgan White Group
        </p>
        <p className="mt-1 text-sm font-semibold">
          {subtitle ? `MWG CRM ${subtitle}` : "MWG CRM"}
        </p>
      </Link>
    </div>
  );
}
