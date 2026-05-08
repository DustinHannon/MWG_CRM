"use client";

import { ArrowLeft, ChevronRight, Home, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { useBreadcrumbs } from "./provider";

/**
 * Phase 11 — breadcrumbs trail. Renders inside the TopBar.
 *
 * Behavior:
 *   • First segment is a Home icon linking to /dashboard.
 *   • All but the last segment are <Link>s.
 *   • Last segment is plain text (the current page).
 *   • A loading segment shows a skeleton chip until label resolves.
 *   • Adjacent <RefreshButton> calls router.refresh() to re-render
 *     Server Components against the latest DB state.
 *
 * Phase 12 Sub-E — at <640px the trail collapses to a single
 * back-arrow (linking to the immediate parent) plus the current
 * segment label. The home icon and intermediate segments hide via
 * `hidden sm:inline-flex`. This matches the mobile contract: trail
 * fits a 380px viewport without elision-clipping the leaf label.
 */
export function Breadcrumbs() {
  const crumbs = useBreadcrumbs();
  // Parent for the mobile back arrow:
  //  • single crumb / leaf only → back to dashboard
  //  • otherwise → previous segment if it has an href, else dashboard
  const last = crumbs[crumbs.length - 1];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const mobileBackHref = parent?.href ?? "/dashboard";
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
    >
      {/* Mobile-only back arrow — visible at <640px when there's a
          parent to go back to. */}
      <Link
        href={mobileBackHref}
        aria-label="Back"
        className="flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground sm:hidden"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
      {/* Desktop home icon — hidden at <640px so the leaf label has
          maximum width on mobile. */}
      <Link
        href="/dashboard"
        className="hidden items-center text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
        aria-label="Home"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      {/* Mobile leaf — current segment only. */}
      {last ? (
        <span
          className="truncate font-medium text-foreground sm:hidden"
          title={last.label}
        >
          {last.loading ? (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-20 animate-pulse rounded bg-muted/60"
            />
          ) : (
            last.label
          )}
        </span>
      ) : null}
      {/* Desktop full trail — every segment with separators. */}
      <span className="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${i}-${c.href ?? c.label}`}>
              <ChevronRight
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
              />
              {c.loading ? (
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-20 animate-pulse rounded bg-muted/60"
                />
              ) : c.href && !isLast ? (
                <Link
                  href={c.href}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                  title={c.label}
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  className="truncate font-medium text-foreground"
                  title={c.label}
                >
                  {c.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </span>
      <RefreshButton />
    </nav>
  );
}

/**
 * Calls router.refresh() with a 400ms minimum spin so the user always
 * sees the click was registered. Also dispatches a window event the
 * realtime poller listens for (so its own polling clock resets).
 */
function RefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [minSpinning, setMinSpinning] = useState(false);
  const spinning = isPending || minSpinning;

  return (
    <button
      type="button"
      aria-label="Refresh"
      onClick={() => {
        setMinSpinning(true);
        // Minimum spin so the click registers visually even on a fast
        // refresh; the timer is allowed to fire after the transition
        // resolves without contention.
        setTimeout(() => setMinSpinning(false), 400);
        startTransition(() => router.refresh());
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("mwg:refresh-now"));
        }
      }}
      className={cn(
        "ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-glass-2/40 hover:text-foreground",
        spinning && "text-foreground",
      )}
    >
      <RotateCw
        className={cn("h-3.5 w-3.5", spinning && "animate-spin")}
        aria-hidden="true"
      />
    </button>
  );
}
