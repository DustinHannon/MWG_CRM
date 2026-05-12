import Link from "next/link";
import { cn } from "@/lib/utils";
import { MWG_LOGO_SVG } from "./mwg-logo-svg";

/**
 * Brand header at the top of the sidebar. Renders
 * [MWG corporate logo — silhouette in currentColor + navy accent]
 * MORGAN WHITE GROUP
 * MWG CRM[ <subtitle>]
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
 *
 * when the sidebar is collapsed (`collapsed=true`) only
 * the logo glyph renders at a smaller size; the wordmark and subtitle
 * are hidden so the 64px rail stays compact.
 */
export function Brand({
  subtitle,
  collapsed = false,
}: {
  subtitle?: string;
  collapsed?: boolean;
}) {
  return (
    <div
      className={cn(
        "text-center",
        collapsed ? "px-2 py-4" : "px-5 py-6",
      )}
    >
      <Link href="/dashboard" className="block">
        <span
          role="img"
          aria-label="Morgan White Group"
          className={cn(
            "mx-auto inline-block text-foreground [&>svg]:mx-auto [&>svg]:w-auto",
            collapsed
              ? "h-9 [&>svg]:h-9"
              : "mb-3 h-16 [&>svg]:h-16",
          )}
          dangerouslySetInnerHTML={{ __html: MWG_LOGO_SVG }}
        />
        {collapsed ? null : (
          <>
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Morgan White Group
            </p>
            <p className="mt-1 text-sm font-semibold">
              {subtitle ? `MWG CRM ${subtitle}` : "MWG CRM"}
            </p>
          </>
        )}
      </Link>
    </div>
  );
}
