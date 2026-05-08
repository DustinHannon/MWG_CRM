"use client";

import { ChevronRight, Home, RotateCw } from "lucide-react";
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
 */
export function Breadcrumbs() {
  const crumbs = useBreadcrumbs();
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
    >
      <Link
        href="/dashboard"
        className="flex items-center text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Home"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
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
