"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * collapsible content section with localStorage-persisted expand state.
 *
 * Generic disclosure widget extracted so the reports page and the
 * admin user-permissions page share the same toggle behavior. The
 * content (cards on /reports, permission toggles on /admin/users) is
 * rendered by the consumer and passed in as `children`.
 *
 * Hydration: on the server `typeof window === "undefined"` and we
 * return `defaultExpanded` — matching the SSR'd markup. On first
 * client paint we may read a different persisted value;
 * `suppressHydrationWarning` on the button + body silences React's
 * attribute-level mismatch warning.
 */

interface StandardCollapsibleSectionProps {
  /** Stable key — used as the localStorage discriminator + DOM ids. */
  sectionKey: string;
  /** Display label rendered in the header. */
  label: string;
  /** Optional badge or count node rendered next to the label. */
  badge?: ReactNode;
  /**
   * Default open state when localStorage has no record.
   */
  defaultExpanded: boolean;
  /** Server-rendered content for this section. */
  children: ReactNode;
  /**
   * localStorage key prefix. Pages override this so independent
   * surfaces (reports vs admin perms) don't clobber each other's
   * persisted state. Defaults to `mwgcrm.collapsible.section.`.
   */
  storagePrefix?: string;
  /**
   * DOM id prefix used for `aria-labelledby` / `aria-controls`.
   * Defaults to `collapsible-section-`.
   */
  domIdPrefix?: string;
}

function readPersisted(storageKey: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch (err) {
    console.warn(
      "[standard/collapsible-section] localStorage read failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function writePersisted(storageKey: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(storageKey, expanded ? "true" : "false");
  } catch (err) {
    console.warn(
      "[standard/collapsible-section] localStorage write failed",
      err instanceof Error ? err.message : err,
    );
  }
}

export function StandardCollapsibleSection({
  sectionKey,
  label,
  badge,
  defaultExpanded,
  children,
  storagePrefix = "mwgcrm.collapsible.section.",
  domIdPrefix = "collapsible-section-",
}: StandardCollapsibleSectionProps) {
  const storageKey = `${storagePrefix}${sectionKey}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultExpanded;
    const persisted = readPersisted(storageKey);
    return persisted ?? defaultExpanded;
  });

  function toggle(): void {
    setExpanded((prev) => {
      const next = !prev;
      writePersisted(storageKey, next);
      return next;
    });
  }

  const headerId = `${domIdPrefix}${sectionKey}-header`;
  const bodyId = `${domIdPrefix}${sectionKey}-body`;

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
          className="flex min-h-[44px] w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
          {badge ? (
            <span className="ml-auto text-xs text-muted-foreground/70">
              {badge}
            </span>
          ) : null}
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
