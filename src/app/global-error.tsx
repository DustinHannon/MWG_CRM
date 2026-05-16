"use client";

// Global error boundary. Renders when an uncaught error escapes the
// root layout itself (segment `error.tsx` boundaries cannot catch
// those). It REPLACES the root layout, so it must render its own
// <html>/<body> and import the global stylesheet — the root layout's
// `import "./globals.css"` does not run for this tree.
//
// Accepted limitation: this <html> carries no theme class (the root
// layout that sets it is bypassed), so this last-resort crash screen
// always renders in the default token palette regardless of the
// user's theme. Semantic tokens keep it legible; not worth a
// no-flash theme script on a root-crash path.
import "./globals.css";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Diagnostic console.error: this boundary catches otherwise-silent
    // root-level render crashes and no structured logger runs at this
    // level on the client. Reason documented per logging policy.
    console.error("App-wide error boundary caught a render error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="w-full max-w-md space-y-4 text-center">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              An unexpected error stopped this page from loading. Try again, or
              return to the homepage.
            </p>
            <div className="flex justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global-error replaces the root layout and renders outside the App Router tree; next/link has no router context here, so a full-document anchor is correct */}
              <a
                href="/"
                className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Go to homepage
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
