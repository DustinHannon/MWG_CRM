import type { PermissionKey } from "@/lib/auth-helpers";

/**
 * Admin user-permission page category catalog.
 *
 * Single source of truth for the rebuilt admin UI. Every permission
 * column on the `permissions` table appears in exactly one category.
 * Adding a new column requires slotting it into the appropriate
 * category here — the rendering layer reads from this constant.
 */

export interface PermissionCategory {
  /** Stable id used as localStorage discriminator + DOM id. */
  readonly id: string;
  /** Display label rendered in the collapsible section header. */
  readonly label: string;
  /** Permission keys in this category, in display order. */
  readonly keys: readonly PermissionKey[];
}

export const PERMISSION_CATEGORIES: readonly PermissionCategory[] = [
  {
    id: "records",
    label: "Records",
    keys: [
      "canViewAllRecords",
      "canCreateLeads",
      "canEditLeads",
      "canDeleteLeads",
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    keys: [
      "canViewOthersTasks",
      "canEditOthersTasks",
      "canDeleteOthersTasks",
      "canReassignTasks",
    ],
  },
  {
    id: "marketing-templates",
    label: "Marketing — Templates",
    keys: [
      "canMarketingTemplatesView",
      "canMarketingTemplatesCreate",
      "canMarketingTemplatesEdit",
      "canMarketingTemplatesDelete",
      "canMarketingTemplatesSendTest",
    ],
  },
  {
    id: "marketing-lists",
    label: "Marketing — Lists",
    keys: [
      "canMarketingListsView",
      "canMarketingListsCreate",
      "canMarketingListsEdit",
      "canMarketingListsDelete",
      "canMarketingListsRefresh",
      "canMarketingListsBulkAdd",
      "canMarketingListsImport",
    ],
  },
  {
    id: "marketing-campaigns",
    label: "Marketing — Campaigns",
    keys: [
      "canMarketingCampaignsView",
      "canMarketingCampaignsCreate",
      "canMarketingCampaignsEdit",
      "canMarketingCampaignsSchedule",
      "canMarketingCampaignsCancel",
      "canMarketingCampaignsDelete",
      "canMarketingCampaignsSendNow",
      "canMarketingCampaignsSendTest",
    ],
  },
  {
    id: "marketing-suppressions",
    label: "Marketing — Suppressions",
    keys: [
      "canMarketingSuppressionsView",
      "canMarketingSuppressionsAdd",
      "canMarketingSuppressionsRemove",
    ],
  },
  {
    id: "marketing-reports-audit",
    label: "Marketing — Reports & Audit",
    keys: ["canMarketingReportsView", "canMarketingAuditView"],
  },
  {
    id: "marketing-migrations",
    label: "Marketing — Migrations",
    keys: ["canMarketingMigrationsRun"],
  },
  {
    id: "communications",
    label: "Communications",
    keys: ["canSendEmail"],
  },
  {
    id: "reports",
    label: "Reports",
    keys: ["canViewReports"],
  },
  {
    id: "import-export",
    label: "Import / Export",
    keys: ["canImport", "canExport"],
  },
] as const;

/**
 * Human-readable label for each permission key. Sentence case per the
 * UI copy conventions. Hints are kept short (≤12 words) per the
 * tooltip guidance.
 */
export const PERMISSION_LABELS: Record<
  PermissionKey,
  { label: string; hint: string }
> = {
  canViewAllRecords: {
    label: "View all records",
    hint: "See leads, accounts, contacts, and opportunities owned by anyone.",
  },
  canCreateLeads: {
    label: "Create leads",
    hint: "Add new leads.",
  },
  canEditLeads: {
    label: "Edit leads",
    hint: "Modify any field on an accessible lead.",
  },
  canDeleteLeads: {
    label: "Delete leads",
    hint: "Archive and permanently remove leads.",
  },
  canViewOthersTasks: {
    label: "View others' tasks",
    hint: "See tasks owned by another user.",
  },
  canEditOthersTasks: {
    label: "Edit others' tasks",
    hint: "Modify tasks owned by another user.",
  },
  canDeleteOthersTasks: {
    label: "Delete others' tasks",
    hint: "Delete tasks owned by another user.",
  },
  canReassignTasks: {
    label: "Reassign tasks",
    hint: "Change the assignee of any task.",
  },
  canMarketingTemplatesView: {
    label: "View templates",
    hint: "Read marketing email templates.",
  },
  canMarketingTemplatesCreate: {
    label: "Create templates",
    hint: "Author new marketing email templates.",
  },
  canMarketingTemplatesEdit: {
    label: "Edit templates",
    hint: "Modify existing marketing email templates.",
  },
  canMarketingTemplatesDelete: {
    label: "Archive templates",
    hint: "Soft-archive marketing email templates.",
  },
  canMarketingTemplatesSendTest: {
    label: "Send template test",
    hint: "Preview a template via single test send.",
  },
  canMarketingListsView: {
    label: "View lists",
    hint: "Read marketing lists and member counts.",
  },
  canMarketingListsCreate: {
    label: "Create lists",
    hint: "Define new dynamic or static marketing lists.",
  },
  canMarketingListsEdit: {
    label: "Edit lists",
    hint: "Modify list name, description, and filter DSL.",
  },
  canMarketingListsDelete: {
    label: "Archive lists",
    hint: "Soft-archive marketing lists.",
  },
  canMarketingListsRefresh: {
    label: "Refresh lists",
    hint: "Trigger on-demand membership recomputation.",
  },
  canMarketingListsBulkAdd: {
    label: "Bulk add to lists",
    hint: "Add visible leads to a list from the leads page.",
  },
  canMarketingListsImport: {
    label: "Import static lists",
    hint: "Upload an Excel workbook to seed static list members.",
  },
  canMarketingCampaignsView: {
    label: "View campaigns",
    hint: "Read marketing campaigns and recipient stats.",
  },
  canMarketingCampaignsCreate: {
    label: "Create campaigns",
    hint: "Draft new marketing campaigns.",
  },
  canMarketingCampaignsEdit: {
    label: "Edit campaigns",
    hint: "Modify draft campaign metadata before send.",
  },
  canMarketingCampaignsSchedule: {
    label: "Schedule campaigns",
    hint: "Queue a campaign for a future send window.",
  },
  canMarketingCampaignsCancel: {
    label: "Cancel campaigns",
    hint: "Cancel a draft or scheduled campaign.",
  },
  canMarketingCampaignsDelete: {
    label: "Delete campaigns",
    hint: "Soft-delete draft or cancelled campaigns.",
  },
  canMarketingCampaignsSendNow: {
    label: "Send campaigns now",
    hint: "Dispatch a campaign immediately bypassing schedule.",
  },
  canMarketingCampaignsSendTest: {
    label: "Send campaign test",
    hint: "Preview a campaign via single test send.",
  },
  canMarketingSuppressionsView: {
    label: "View suppressions",
    hint: "Read the suppression list.",
  },
  canMarketingSuppressionsAdd: {
    label: "Add suppressions",
    hint: "Add an email address to the suppression list.",
  },
  canMarketingSuppressionsRemove: {
    label: "Remove suppressions",
    hint: "Remove an email address from the suppression list.",
  },
  canMarketingReportsView: {
    label: "View marketing reports",
    hint: "Access the marketing reports surface and exports.",
  },
  canMarketingAuditView: {
    label: "View marketing audit",
    hint: "Read the forensic audit log of marketing actions.",
  },
  canMarketingMigrationsRun: {
    label: "Run marketing migrations",
    hint: "Execute the ClickDimensions migration tooling.",
  },
  canSendEmail: {
    label: "Send transactional email",
    hint: "Send messages from the lead detail page.",
  },
  canViewReports: {
    label: "View reports",
    hint: "Access the reports tab and dashboard analytics.",
  },
  canImport: {
    label: "Import data",
    hint: "Bulk-import leads from spreadsheets.",
  },
  canExport: {
    label: "Export data",
    hint: "Download filtered leads as Excel.",
  },
};
