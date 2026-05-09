import Image from "next/image";
import Link from "next/link";

/**
 * Brand header at the top of the sidebar. Renders
 *   [MWG corporate logo — white + navy as designed]
 *   MORGAN WHITE GROUP
 *   MWG CRM[ <subtitle>]
 *
 * The logo asset (`public/brand/mwg-logo.svg`) ships its full
 * brand-identity palette: white silhouette + #00205C navy accent in
 * the center. Rendering as <Image> preserves both colors. An earlier
 * mask-image approach flattened the SVG to one color (loses the navy
 * center) and is intentionally NOT used here — the canonical brand
 * asset has its own colors and we render them as designed.
 *
 * The subtitle preserves the historical "MWG CRM Admin" treatment
 * used by the admin section; defaults to no subtitle for the main app.
 */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="px-5 py-6">
      <Link href="/dashboard" className="block">
        {/* Logo intrinsic viewBox is 275.114 × 230.226 → 1.195:1.
            64px tall keeps the row visually anchored without
            crowding the eyebrow + title underneath. */}
        <Image
          src="/brand/mwg-logo.svg"
          alt="Morgan White Group"
          width={77}
          height={64}
          priority
          className="mb-3 block h-16 w-auto"
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
