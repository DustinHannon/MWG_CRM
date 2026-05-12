import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import {
  StandardPageHeader,
  type StandardPageHeaderProps,
} from "./standard-page-header";

/**
 * / §5.4 — canonical detail-page header.
 *
 * Composes <StandardPageHeader> with an optional Back link rendered
 * above the title. Used on entity detail pages (lead, contact,
 * template, campaign, list, run) where the user came from a list and
 * needs a one-click escape.
 *
 * Detail pages with bespoke layouts (the lead-detail page with its
 * sidebar + timeline) keep their inlined headers — the standard
 * variant covers the simpler card-shell detail pages.
 */
export interface StandardDetailHeaderProps extends StandardPageHeaderProps {
  /** "Back to X" link rendered above the heading. Optional. */
  backTo?: { href: string; label: string };
}

export function StandardDetailHeader({
  backTo,
  ...headerProps
}: StandardDetailHeaderProps) {
  return (
    <div className="space-y-1.5">
      {backTo ? (
        <Link
          href={backTo.href}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={1.5}
          />
          <span>{backTo.label}</span>
        </Link>
      ) : null}
      <StandardPageHeader {...headerProps} />
    </div>
  );
}

export type { ReactNode };
