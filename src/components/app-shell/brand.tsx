import Link from "next/link";
import { MWG_LOGO_SVG } from "./mwg-logo-svg";

/**
 * Brand header at the top of the sidebar. Renders
 *   [MWG corporate logo — silhouette in currentColor + navy accent]
 *   MORGAN WHITE GROUP
 *   MWG CRM[ <subtitle>]
 *
 * The logo asset (`public/brand/mwg-logo.svg`) ships with white
 * silhouette paths PLUS a #00205C navy accent. An `<img>` rendering
 * only worked on dark backgrounds — on the light theme the white
 * silhouette disappeared and only the navy circle remained visible.
 *
 * Fix: the silhouette paths are pre-processed into `MWG_LOGO_SVG` with
 * `fill="#FFFFFF"` swapped for `fill="currentColor"`. The container's
 * `text-foreground` then drives the silhouette color — light text on
 * dark theme, dark text on light theme. The `#00205C` navy accent
 * stays hardcoded so it reads on either side. Source SVG file on disk
 * is unchanged (matches CDN copy).
 *
 * The brand block is centered horizontally — the sidebar is 240 px
 * and a left-aligned 64 px logo with a centered title underneath
 * looks unbalanced.
 */
export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="px-5 py-6 text-center">
      <Link href="/dashboard" className="block">
        <span
          role="img"
          aria-label="Morgan White Group"
          className="mx-auto mb-3 inline-block h-16 text-foreground [&>svg]:mx-auto [&>svg]:h-16 [&>svg]:w-auto"
          dangerouslySetInnerHTML={{ __html: MWG_LOGO_SVG }}
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
