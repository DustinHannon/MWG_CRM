"use client";

// Segment error boundary. Catches uncaught render errors in any page
// below `app/` (the root layout, TopBar, and global chrome stay
// mounted). Root-layout-level throws are handled by `global-error.tsx`
// instead. Same inline markup as global-error by design — two
// instances, so no shared abstraction is extracted (Rule of 3).
import Link from "next/link";
import { useEffect } from "react";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Diagnostic console.error: surfaces the segment-level fault in the
    // browser console for support triage; server-side causes are
    // already captured by the structured logger upstream.
    console.error("Route segment error boundary caught a render error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          This page hit an unexpected error. Try again, or return to the
          homepage.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go to homepage
          </Link>
        </div>
      </div>
    </div>
  );
}
