"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Phase 24 — collapsible category section on the /reports page.
 *
 * Owns ONLY the toggle state + visibility wrapper. The card grid
 * itself (which uses `UserTime` and other server-only utilities)
 * is rendered by the parent SERVER component and passed in as
 * `children`. This keeps `server-only` modules out of the client
 * bundle while still letting the disclosure toggle live in a
 * "use client" component.
 *
 * Pattern mirrors the click-to-expand chevron + aria-expanded
 * convention from `src/components/leads/email-activity-timeline.tsx`.
 * No accordion primitive exists in the codebase
 * (`src/components/ui/`) and CLAUDE.md says not to introduce one for
 * a single use site.
 */

interface CategorySectionProps {
  /** Stable key — used as the localStorage discriminator + DOM ids. */
  categoryKey: string;
  /** Display label rendered in the header. */
  label: string;
  /** Report count for the header badge. */
  count: number;
  /**
   * Default open state when localStorage has no record. Used to
   * surface the first non-empty bucket on first visit.
   */
  defaultExpanded: boolean;
  /** Server-rendered card grid for this category. */
  children: ReactNode;
}

const STORAGE_PREFIX = "mwgcrm.reports.category.";

function readPersisted(categoryKey: string): boolean | null {
  // localStorage throws in private modes / disabled-storage / quota
  // scenarios. The console.warn is the documented client-side
  // diagnostic-fallback exception per CLAUDE.md "Errors and logging".
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + categoryKey);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch (err) {
    console.warn(
      "[reports/category-section] localStorage read failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function writePersisted(categoryKey: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + categoryKey,
      expanded ? "true" : "false",
    );
  } catch (err) {
    console.warn(
      "[reports/category-section] localStorage write failed",
      err instanceof Error ? err.message : err,
    );
  }
}

export function CategorySection({
  categoryKey,
  label,
  count,
  defaultExpanded,
  children,
}: CategorySectionProps) {
  // Lazy initializer reads localStorage exactly once on first render.
  // Picked over `useEffect + setState` because the React 19 lint rule
  // `react-hooks/set-state-in-effect` flags effect-driven re-renders,
  // and over `useSyncExternalStore` because same-tab writes don't
  // fire the `storage` event so the external-store pattern would
  // need its own pub/sub for a single low-stakes toggle.
  //
  // Hydration: on the server `typeof window === "undefined"` and we
  // return `defaultExpanded` — matching the SSR'd markup. On first
  // client paint we may read a different persisted value;
  // `suppressHydrationWarning` on the button + body silences React's
  // attribute-level mismatch warning.
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultExpanded;
    const persisted = readPersisted(categoryKey);
    return persisted ?? defaultExpanded;
  });

  function toggle(): void {
    setExpanded((prev) => {
      const next = !prev;
      writePersisted(categoryKey, next);
      return next;
    });
  }

  const headerId = `reports-category-${categoryKey}-header`;
  const bodyId = `reports-category-${categoryKey}-body`;

  return (
    <section className="rounded-2xl border border-border/40 bg-muted/10">
      <h3 className="m-0">
        <button
          type="button"
          id={headerId}
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          suppressHydrationWarning
          className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {expanded ? (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          <span className="text-xs text-muted-foreground/70">{count}</span>
        </button>
      </h3>
      <div
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!expanded}
        suppressHydrationWarning
        className="px-4 pb-4 pt-1"
      >
        {children}
      </div>
    </section>
  );
}
