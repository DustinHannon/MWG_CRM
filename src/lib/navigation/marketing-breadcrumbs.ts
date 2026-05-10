import type { Breadcrumb } from "@/components/breadcrumbs";

/**
 * Phase 21 §3.7 — Marketing route → breadcrumb trail registry.
 *
 * Sub-agents render `<BreadcrumbsSetter crumbs={marketingCrumbs.<route>(...)} />`
 * (or the static array variant) in their server-component pages. Adding a new
 * marketing route requires adding it here so the breadcrumb pattern stays
 * consistent across the marketing tab.
 *
 * The Phase 11 `<Breadcrumbs />` component renders these via the topbar.
 */

const ROOT: Breadcrumb = { label: "Marketing", href: "/marketing" };

export const marketingCrumbs = {
  index: (): Breadcrumb[] => [{ label: "Marketing" }],

  templatesIndex: (): Breadcrumb[] => [
    ROOT,
    { label: "Templates" },
  ],
  templatesNew: (): Breadcrumb[] => [
    ROOT,
    { label: "Templates", href: "/marketing/templates" },
    { label: "New template" },
  ],
  templatesDetail: (name: string): Breadcrumb[] => [
    ROOT,
    { label: "Templates", href: "/marketing/templates" },
    { label: name },
  ],
  templatesEdit: (name: string, id: string): Breadcrumb[] => [
    ROOT,
    { label: "Templates", href: "/marketing/templates" },
    { label: name, href: `/marketing/templates/${id}` },
    { label: "Edit" },
  ],

  listsIndex: (): Breadcrumb[] => [
    ROOT,
    { label: "Lists" },
  ],
  listsNew: (): Breadcrumb[] => [
    ROOT,
    { label: "Lists", href: "/marketing/lists" },
    { label: "New list" },
  ],
  listsDetail: (name: string): Breadcrumb[] => [
    ROOT,
    { label: "Lists", href: "/marketing/lists" },
    { label: name },
  ],
  listsEdit: (name: string, id: string): Breadcrumb[] => [
    ROOT,
    { label: "Lists", href: "/marketing/lists" },
    { label: name, href: `/marketing/lists/${id}` },
    { label: "Edit" },
  ],

  campaignsIndex: (): Breadcrumb[] => [
    ROOT,
    { label: "Campaigns" },
  ],
  campaignsNew: (): Breadcrumb[] => [
    ROOT,
    { label: "Campaigns", href: "/marketing/campaigns" },
    { label: "New campaign" },
  ],
  campaignsDetail: (name: string): Breadcrumb[] => [
    ROOT,
    { label: "Campaigns", href: "/marketing/campaigns" },
    { label: name },
  ],
  campaignsEdit: (name: string, id: string): Breadcrumb[] => [
    ROOT,
    { label: "Campaigns", href: "/marketing/campaigns" },
    { label: name, href: `/marketing/campaigns/${id}` },
    { label: "Edit" },
  ],

  suppressionsIndex: (): Breadcrumb[] => [
    ROOT,
    { label: "Suppressions" },
  ],

  auditIndex: (): Breadcrumb[] => [
    ROOT,
    { label: "Audit Log" },
  ],
} as const;
