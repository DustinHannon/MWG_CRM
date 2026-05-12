// Pure data + grouping module. No "server-only" — safe to import from
// client components (the categorization runs on whatever shape of
// reports the server hands us; perm-gating happens at the server-page
// layer before reports reach this module).
import type { ReportEntityType } from "@/db/schema/saved-reports";
import type { ReportListItem } from "@/lib/reports/repository";

/**
 * /reports built-in catalog categorization.
 *
 * Reports in the saved_reports table are tagged by `entity_type`
 * (e.g. "lead", "opportunity", "marketing_campaign"). The reports
 * page used to render every built-in as a flat list. As the catalog
 * grows (currently 13 built-ins, more incoming) this gets harder to
 * scan. We group by topic.
 *
 * NOTE: this module is intentionally pure data. The server page
 * filters marketing-entity reports out for users without
 * `canManageMarketing` BEFORE the reports reach this module — no
 * permission logic here.
 */

export interface ReportCategory {
  /** Stable key — used as the localStorage discriminator + React key. */
  readonly key: string;
  /** Display label rendered as the section header. */
  readonly label: string;
  /** Entity types that bucket into this category. */
  readonly entityTypes: readonly ReportEntityType[];
}

/**
 * The category catalog. Order = display order on the page.
 *
 * Buckets:
 * Leads
 * Accounts & Contacts (both client-facing entities live together)
 * Opportunities
 * Tasks
 * Activities
 * Marketing & Email (three marketing entities + transactional log)
 */
export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  { key: "leads", label: "Leads", entityTypes: ["lead"] },
  {
    key: "accounts",
    label: "Accounts & Contacts",
    entityTypes: ["account", "contact"],
  },
  { key: "opportunities", label: "Opportunities", entityTypes: ["opportunity"] },
  { key: "tasks", label: "Tasks", entityTypes: ["task"] },
  { key: "activities", label: "Activities", entityTypes: ["activity"] },
  {
    key: "marketing",
    label: "Marketing & Email",
    entityTypes: [
      "marketing_campaign",
      "marketing_email_event",
      "email_send_log",
    ],
  },
];

export interface CategoryGroup {
  category: ReportCategory;
  reports: ReportListItem[];
}

/**
 * Bucket the supplied reports by category. Categories with zero
 * matching reports are dropped — the UI never renders an empty
 * disclosure. Reports whose `entityType` doesn't map to any
 * registered category are returned in a trailing "Other" bucket;
 * this catches future entity types whose category wiring hasn't been
 * added yet (better to surface them than swallow them silently).
 */
export function groupBuiltinReports(
  reports: readonly ReportListItem[],
): CategoryGroup[] {
  const out: CategoryGroup[] = [];
  const consumed = new Set<string>();

  for (const category of REPORT_CATEGORIES) {
    const allowed = new Set<string>(category.entityTypes);
    const bucket = reports.filter(
      (r) => !consumed.has(r.id) && allowed.has(r.entityType),
    );
    if (bucket.length === 0) continue;
    for (const r of bucket) consumed.add(r.id);
    out.push({ category, reports: bucket });
  }

  // Trailing "Other" bucket — only if any reports went unclaimed by
  // a registered category. Defensive — should be empty in practice.
  const orphans = reports.filter((r) => !consumed.has(r.id));
  if (orphans.length > 0) {
    out.push({
      category: {
        key: "other",
        label: "Other",
        entityTypes: [] as never,
      },
      reports: orphans,
    });
  }

  return out;
}

/**
 * Returns true if the given entity type belongs to the
 * marketing/email category — used by the server page to filter the
 * fetched-but-gated reports list when the viewer lacks
 * canManageMarketing. Kept here so the gating uses the SAME entity
 * list as the category buckets.
 */
const MARKETING_CATEGORY = REPORT_CATEGORIES.find((c) => c.key === "marketing");
const MARKETING_ENTITY_SET = new Set<string>(
  MARKETING_CATEGORY?.entityTypes ?? [],
);

export function isMarketingReportEntity(entityType: string): boolean {
  return MARKETING_ENTITY_SET.has(entityType);
}
