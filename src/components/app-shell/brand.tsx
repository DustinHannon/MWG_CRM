import Link from "next/link";

/**
 * Brand header at the top of the sidebar. Renders
 *   [MWG corporate logo]
 *   MORGAN WHITE GROUP
 *   MWG CRM[ <subtitle>]
 *
 * The logo uses CSS `mask-image` so its color inherits from the
 * sidebar's text color (`bg-foreground` driven by `--foreground`),
 * keeping it visible in both light and dark themes. The SVG asset
 * lives at `public/brand/mwg-logo.svg` (intrinsic viewBox
 * 275.114 × 230.226, white-fill paths in source — color is supplied
 * by the mask host element).
 *
 * The subtitle preserves the historical "MWG CRM Admin" treatment
 * used by the admin section; defaults to no subtitle for the main app.
 */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="px-5 py-6">
      <Link href="/dashboard" className="block">
        <span
          role="img"
          aria-label="Morgan White Group"
          className="mb-3 block h-9 w-[44px] bg-foreground [mask-image:url(/brand/mwg-logo.svg)] [mask-position:left_center] [mask-repeat:no-repeat] [mask-size:contain] [-webkit-mask-image:url(/brand/mwg-logo.svg)] [-webkit-mask-position:left_center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]"
        />
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
