import type { MarketingTemplateStatus } from "@/db/schema/marketing-templates";
import { Pill } from "./pill";

/**
 * draft / ready / archived — the marketing-template lifecycle pill.
 * Per-concept sibling of StatusPill / PriorityPill / ActivityPill,
 * built on the shared <Pill> base, used by the template editor and
 * the template detail page (it replaced a per-page-duplicated local
 * pill). The status is a closed DB-enum union, so the maps are
 * exhaustive (no `?? default` needed).
 */
const VARIANTS: Record<MarketingTemplateStatus, string> = {
  ready: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  archived: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  draft: "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
};

const LABELS: Record<MarketingTemplateStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  archived: "Archived",
};

export interface TemplateStatusPillProps {
  status: MarketingTemplateStatus;
  className?: string;
}

export function TemplateStatusPill({
  status,
  className,
}: TemplateStatusPillProps) {
  return (
    <Pill variant={VARIANTS[status]} className={className}>
      {LABELS[status]}
    </Pill>
  );
}
