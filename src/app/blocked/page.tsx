import type { Metadata } from "next";

/**
 * Phase 26 §6 — geo-block destination page.
 *
 * Rendered by `src/proxy.ts` via `NextResponse.rewrite(..., { status: 403 })`
 * whenever a request originates from a country outside
 * `env.GEO_ALLOWED_COUNTRIES`. The page is intentionally minimal:
 *
 *   - No links into the CRM (sign-in, dashboard, etc.).
 *   - No API calls — the request is already blocked at the edge.
 *   - No Card primitive, no app shell, no nav.
 *   - Only Tailwind semantic tokens (`bg-background`, `text-foreground`,
 *     `text-muted-foreground`) so theming stays consistent if a future
 *     screenshot ends up in support tickets.
 *
 * Metadata opts the page out of indexing so search engines don't
 * surface a public "Service unavailable" landing page above the real
 * marketing site.
 */
export const metadata: Metadata = {
  title: "Service unavailable",
  robots: { index: false, follow: false },
};

export const dynamic = "force-static";

export default function BlockedPage() {
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center px-6 py-12">
      <div className="max-w-md w-full text-center space-y-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-medium">
          403
        </p>
        <h1 className="text-2xl font-semibold">Service unavailable</h1>
        <p className="text-sm text-muted-foreground">
          This application is only available from approved regions. If
          you believe you are seeing this message in error, contact your
          Morgan White Group administrator.
        </p>
      </div>
    </main>
  );
}
