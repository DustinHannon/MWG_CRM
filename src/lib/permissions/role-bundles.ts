/**
 * Phase 27 §4.6 — Marketing role bundles.
 *
 * Each bundle is a preset for the 24 fine-grained marketing permissions
 * shipped on the `permissions` table. The admin UI ("Apply role bundle")
 * sets the 24 columns for the target user according to one of these
 * presets. Individual columns can still be toggled afterwards.
 *
 * The bundles are TypeScript constants (no DB rows) so they can be
 * extended / renamed in code without a migration. The audit event
 * `permissions.role_bundle.apply` carries the bundle name as the value.
 */

import type { MarketingPermissionKey } from "@/lib/auth-helpers";

export type MarketingRoleBundle =
  | "marketing_viewer"
  | "marketing_creator"
  | "marketing_campaigner"
  | "marketing_sender"
  | "marketing_admin";

const ALL_VIEW: MarketingPermissionKey[] = [
  "canMarketingTemplatesView",
  "canMarketingListsView",
  "canMarketingCampaignsView",
  "canMarketingSuppressionsView",
  "canMarketingReportsView",
  "canMarketingAuditView",
];

const CREATOR_PERMS: MarketingPermissionKey[] = [
  ...ALL_VIEW,
  "canMarketingTemplatesCreate",
  "canMarketingTemplatesEdit",
  "canMarketingTemplatesDelete",
  "canMarketingTemplatesSendTest",
  "canMarketingListsCreate",
  "canMarketingListsEdit",
  "canMarketingListsDelete",
  "canMarketingListsRefresh",
  "canMarketingListsBulkAdd",
  // Phase 29 §5 — Creators can import static lists from Excel.
  "canMarketingListsImport",
  "canMarketingCampaignsCreate",
  "canMarketingCampaignsEdit",
  "canMarketingCampaignsSendTest",
];

const CAMPAIGNER_PERMS: MarketingPermissionKey[] = [
  ...CREATOR_PERMS,
  "canMarketingCampaignsSchedule",
  "canMarketingCampaignsCancel",
  "canMarketingCampaignsDelete",
  "canMarketingCampaignsSendNow",
];

const ADMIN_PERMS: MarketingPermissionKey[] = [
  ...CAMPAIGNER_PERMS,
  "canMarketingSuppressionsAdd",
  "canMarketingSuppressionsRemove",
  // Phase 29 §7 — Admins can run the ClickDimensions template migration.
  "canMarketingMigrationsRun",
];

const SENDER_PERMS: MarketingPermissionKey[] = [
  ...ALL_VIEW,
  "canMarketingCampaignsSendNow",
];

/**
 * Map of bundle name → the permission keys it sets to `true`. All other
 * marketing keys are set to `false` when the bundle is applied.
 */
export const ROLE_BUNDLES: Record<MarketingRoleBundle, MarketingPermissionKey[]> = {
  marketing_viewer: [...ALL_VIEW],
  marketing_creator: [...CREATOR_PERMS],
  marketing_campaigner: [...CAMPAIGNER_PERMS],
  marketing_sender: [...SENDER_PERMS],
  marketing_admin: [...ADMIN_PERMS],
};

/**
 * Full set of marketing permission keys for use when applying a bundle
 * (we need to set every key, not just the truthy ones — false-set is
 * the difference between bundles).
 */
export const ALL_MARKETING_KEYS: MarketingPermissionKey[] = [
  "canMarketingTemplatesView",
  "canMarketingTemplatesCreate",
  "canMarketingTemplatesEdit",
  "canMarketingTemplatesDelete",
  "canMarketingTemplatesSendTest",
  "canMarketingListsView",
  "canMarketingListsCreate",
  "canMarketingListsEdit",
  "canMarketingListsDelete",
  "canMarketingListsRefresh",
  "canMarketingListsBulkAdd",
  "canMarketingCampaignsView",
  "canMarketingCampaignsCreate",
  "canMarketingCampaignsEdit",
  "canMarketingCampaignsSchedule",
  "canMarketingCampaignsCancel",
  "canMarketingCampaignsDelete",
  "canMarketingCampaignsSendNow",
  "canMarketingCampaignsSendTest",
  "canMarketingSuppressionsView",
  "canMarketingSuppressionsAdd",
  "canMarketingSuppressionsRemove",
  "canMarketingReportsView",
  "canMarketingAuditView",
  // Phase 29 §5 + §7 — static-list import + CD migrations admin.
  "canMarketingListsImport",
  "canMarketingMigrationsRun",
];

/**
 * Resolve a bundle name into the column→bool map to write.
 * Keys not in the bundle's truthy list become `false`.
 */
export function resolveBundle(
  bundle: MarketingRoleBundle,
): Record<MarketingPermissionKey, boolean> {
  const truthy = new Set(ROLE_BUNDLES[bundle]);
  const out = {} as Record<MarketingPermissionKey, boolean>;
  for (const key of ALL_MARKETING_KEYS) {
    out[key] = truthy.has(key);
  }
  return out;
}

/**
 * Friendly labels for the admin UI.
 */
export const ROLE_BUNDLE_LABELS: Record<MarketingRoleBundle, string> = {
  marketing_viewer: "Viewer — read-only across marketing",
  marketing_creator: "Creator — templates + lists + draft campaigns; no send",
  marketing_campaigner: "Campaigner — full campaign authoring + send",
  marketing_sender: "Sender — send only; no authoring",
  marketing_admin: "Admin — everything including suppressions management",
};
