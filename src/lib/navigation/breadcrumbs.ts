import type { Breadcrumb } from "@/components/breadcrumbs";
import { marketingCrumbs } from "./marketing-breadcrumbs";

/**
 * Global breadcrumb registry.
 *
 * Every page under (app) and /admin renders a breadcrumb trail via
 * <BreadcrumbsSetter crumbs={...} />. Historically pages have inlined
 * the trail array. This module centralizes the trails so new pages
 * reference a typed entry and renames stay consistent.
 *
 * The marketing trails live in `marketing-breadcrumbs.ts`
 * and are merged here so callers have a single import.
 *
 * Existing pages with inlined trails continue to work; new pages should
 * prefer the registry entries below. Auth and error pages render no
 * breadcrumbs by design and are excluded.
 *
 * Static trails are arrays; dynamic trails (those that include a
 * record's display name or id) are factories.
 */

const HOME: Breadcrumb = { label: "Home", href: "/dashboard" };

export const appCrumbs = {
  // Top-level
  dashboard: (): Breadcrumb[] => [{ label: "Dashboard" }],
  welcome: (): Breadcrumb[] => [{ label: "Welcome" }],
  notifications: (): Breadcrumb[] => [{ label: "Notifications" }],
  settings: (): Breadcrumb[] => [{ label: "Settings" }],

  // Leads
  leadsIndex: (): Breadcrumb[] => [{ label: "Leads" }],
  leadsPipeline: (): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: "Pipeline" },
  ],
  leadsArchived: (): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: "Archived" },
  ],
  leadsImport: (): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: "Import" },
  ],
  leadsNew: (): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: "New lead" },
  ],
  leadsDetail: (name: string): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: name },
  ],
  leadsEdit: (name: string, id: string): Breadcrumb[] => [
    { label: "Leads", href: "/leads" },
    { label: name, href: `/leads/${id}` },
    { label: "Edit" },
  ],

  // Contacts
  contactsIndex: (): Breadcrumb[] => [{ label: "Contacts" }],
  contactsArchived: (): Breadcrumb[] => [
    { label: "Contacts", href: "/contacts" },
    { label: "Archived" },
  ],
  contactsNew: (): Breadcrumb[] => [
    { label: "Contacts", href: "/contacts" },
    { label: "New contact" },
  ],
  contactsDetail: (name: string): Breadcrumb[] => [
    { label: "Contacts", href: "/contacts" },
    { label: name },
  ],

  // Accounts
  accountsIndex: (): Breadcrumb[] => [{ label: "Accounts" }],
  accountsArchived: (): Breadcrumb[] => [
    { label: "Accounts", href: "/accounts" },
    { label: "Archived" },
  ],
  accountsNew: (): Breadcrumb[] => [
    { label: "Accounts", href: "/accounts" },
    { label: "New account" },
  ],
  accountsDetail: (name: string): Breadcrumb[] => [
    { label: "Accounts", href: "/accounts" },
    { label: name },
  ],

  // Opportunities
  opportunitiesIndex: (): Breadcrumb[] => [{ label: "Opportunities" }],
  opportunitiesPipeline: (): Breadcrumb[] => [
    { label: "Opportunities", href: "/opportunities" },
    { label: "Pipeline" },
  ],
  opportunitiesArchived: (): Breadcrumb[] => [
    { label: "Opportunities", href: "/opportunities" },
    { label: "Archived" },
  ],
  opportunitiesNew: (): Breadcrumb[] => [
    { label: "Opportunities", href: "/opportunities" },
    { label: "New opportunity" },
  ],
  opportunitiesDetail: (name: string): Breadcrumb[] => [
    { label: "Opportunities", href: "/opportunities" },
    { label: name },
  ],

  // Tasks
  tasksIndex: (): Breadcrumb[] => [{ label: "Tasks" }],
  tasksArchived: (): Breadcrumb[] => [
    { label: "Tasks", href: "/tasks" },
    { label: "Archived" },
  ],

  // Reports
  reportsIndex: (): Breadcrumb[] => [{ label: "Reports" }],
  reportsBuilder: (): Breadcrumb[] => [
    { label: "Reports", href: "/reports" },
    { label: "Report builder" },
  ],
  reportsDetail: (name: string): Breadcrumb[] => [
    { label: "Reports", href: "/reports" },
    { label: name },
  ],
  reportsEdit: (name: string, id: string): Breadcrumb[] => [
    { label: "Reports", href: "/reports" },
    { label: name, href: `/reports/${id}` },
    { label: "Edit" },
  ],

  // User profile / detail
  userDetail: (name: string): Breadcrumb[] => [
    { label: "Users", href: "/admin/users" },
    { label: name },
  ],

  // API help
  apihelp: (): Breadcrumb[] => [{ label: "API reference" }],
} as const;

const ADMIN: Breadcrumb = { label: "Admin", href: "/admin" };

export const adminCrumbs = {
  index: (): Breadcrumb[] => [{ label: "Admin" }],
  audit: (): Breadcrumb[] => [ADMIN, { label: "Audit log" }],
  users: (): Breadcrumb[] => [ADMIN, { label: "Users" }],
  usersHelp: (): Breadcrumb[] => [
    ADMIN,
    { label: "Users", href: "/admin/users" },
    { label: "Help" },
  ],
  userDetail: (name: string): Breadcrumb[] => [
    ADMIN,
    { label: "Users", href: "/admin/users" },
    { label: name },
  ],
  scoring: (): Breadcrumb[] => [ADMIN, { label: "Scoring" }],
  scoringHelp: (): Breadcrumb[] => [
    ADMIN,
    { label: "Scoring", href: "/admin/scoring" },
    { label: "Help" },
  ],
  tags: (): Breadcrumb[] => [ADMIN, { label: "Tags" }],
  apiKeys: (): Breadcrumb[] => [ADMIN, { label: "API keys" }],
  apiUsage: (): Breadcrumb[] => [ADMIN, { label: "API usage" }],
  data: (): Breadcrumb[] => [ADMIN, { label: "Data" }],
  settings: (): Breadcrumb[] => [ADMIN, { label: "Settings" }],
  importHelp: (): Breadcrumb[] => [ADMIN, { label: "Import help" }],
  emailFailures: (): Breadcrumb[] => [ADMIN, { label: "Email failures" }],

  // Platform insights — Better Stack-driven dashboard
  // for traffic, error rate, and deployment health.
  insights: (): Breadcrumb[] => [ADMIN, { label: "Platform insights" }],

  // Server logs — aggregated telemetry from the
  // Better Stack drain. Not a raw log tail.
  serverLogs: (): Breadcrumb[] => [ADMIN, { label: "Server logs" }],

  // D365 import
  d365Import: (): Breadcrumb[] => [ADMIN, { label: "D365 import" }],
  d365ImportRun: (runShortId: string): Breadcrumb[] => [
    ADMIN,
    { label: "D365 import", href: "/admin/d365-import" },
    { label: `Run ${runShortId}` },
  ],
  d365ImportBatch: (
    runId: string,
    runShortId: string,
    batchNumber: number | string,
  ): Breadcrumb[] => [
    ADMIN,
    { label: "D365 import", href: "/admin/d365-import" },
    { label: `Run ${runShortId}`, href: `/admin/d365-import/${runId}` },
    { label: `Batch #${batchNumber}` },
  ],

  // Migrations — ClickDimensions template-migration
  // worklist. Index page is a thin landing surface; the meaningful
  // surface is the ClickDimensions sub-page.
  migrationsIndex: (): Breadcrumb[] => [ADMIN, { label: "Migrations" }],
  migrationsClickDimensions: (): Breadcrumb[] => [
    ADMIN,
    { label: "Migrations", href: "/admin/migrations" },
    { label: "ClickDimensions" },
  ],
} as const;

/**
 * Re-export the marketing trails so callers have one canonical entry
 * point. `marketingCrumbs.<route>(...)` continues to work for pages
 * that already imported it directly.
 */
export { marketingCrumbs };

// Convenience alias for documentation. New pages can import {
// breadcrumbs } from "@/lib/navigation/breadcrumbs" and reach the
// whole tree via breadcrumbs.app, breadcrumbs.admin, breadcrumbs.marketing.
export const breadcrumbs = {
  app: appCrumbs,
  admin: adminCrumbs,
  marketing: marketingCrumbs,
  home: HOME,
} as const;
