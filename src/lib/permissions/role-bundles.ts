/**
 * Marketing role bundles.
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

/**
 * Tag-governance permission keys included in marketing role bundles so
 * users with marketing roles can apply tags (Creator+) and manage the tag
 * library (Admin). Kept separate from MarketingPermissionKey so the rest
 * of the marketing surface doesn't accidentally infer tag keys.
 */
type TagPermissionKey = "canApplyTags" | "canManageTagDefinitions";

export type RoleBundlePermissionKey = MarketingPermissionKey | TagPermissionKey;

export type MarketingRoleBundle =
  | "marketing_viewer"
  | "marketing_creator"
  | "marketing_campaigner"
  | "marketing_sender"
  | "marketing_admin";

const ALL_VIEW: RoleBundlePermissionKey[] = [
  "canMarketingTemplatesView",
  "canMarketingListsView",
  "canMarketingCampaignsView",
  "canMarketingSuppressionsView",
  "canMarketingReportsView",
  "canMarketingAuditView",
];

const CREATOR_PERMS: RoleBundlePermissionKey[] = [
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
  // Creators can import static lists from Excel.
  "canMarketingListsImport",
  "canMarketingCampaignsCreate",
  "canMarketingCampaignsEdit",
  "canMarketingCampaignsSendTest",
  // Creators can apply tags to records.
  "canApplyTags",
];

const CAMPAIGNER_PERMS: RoleBundlePermissionKey[] = [
  ...CREATOR_PERMS,
  "canMarketingCampaignsSchedule",
  "canMarketingCampaignsCancel",
  "canMarketingCampaignsDelete",
  "canMarketingCampaignsSendNow",
];

const ADMIN_PERMS: RoleBundlePermissionKey[] = [
  ...CAMPAIGNER_PERMS,
  "canMarketingSuppressionsAdd",
  "canMarketingSuppressionsRemove",
  // Admins can run the ClickDimensions template migration.
  "canMarketingMigrationsRun",
  // Admins can manage tag library (rename, recolor, delete).
  "canManageTagDefinitions",
];

const SENDER_PERMS: RoleBundlePermissionKey[] = [
  ...ALL_VIEW,
  "canMarketingCampaignsSendNow",
  // Senders can apply tags to records.
  "canApplyTags",
];

/**
 * Map of bundle name → the permission keys it sets to `true`. All other
 * bundle keys are set to `false` when the bundle is applied.
 */
export const ROLE_BUNDLES: Record<
  MarketingRoleBundle,
  RoleBundlePermissionKey[]
> = {
  marketing_viewer: [...ALL_VIEW],
  marketing_creator: [...CREATOR_PERMS],
  marketing_campaigner: [...CAMPAIGNER_PERMS],
  marketing_sender: [...SENDER_PERMS],
  marketing_admin: [...ADMIN_PERMS],
};

/**
 * Full set of role-bundle permission keys for use when applying a
 * bundle. Every key in this list is written on bundle apply — the keys
 * present in `ROLE_BUNDLES[bundle]` get `true`; the rest get `false`.
 * Includes both marketing keys and the tag-governance keys so a bundle
 * can grant/revoke tag perms alongside marketing perms.
 */
export const ALL_MARKETING_KEYS: RoleBundlePermissionKey[] = [
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
  // + §7 — static-list import + CD migrations admin.
  "canMarketingListsImport",
  "canMarketingMigrationsRun",
  // Tag governance — apply tags + manage tag library.
  "canApplyTags",
  "canManageTagDefinitions",
];

/**
 * Resolve a bundle name into the column→bool map to write.
 * Keys not in the bundle's truthy list become `false`.
 */
export function resolveBundle(
  bundle: MarketingRoleBundle,
): Record<RoleBundlePermissionKey, boolean> {
  const truthy = new Set<RoleBundlePermissionKey>(ROLE_BUNDLES[bundle]);
  const out = {} as Record<RoleBundlePermissionKey, boolean>;
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

/**
 * True if the user holds at least one marketing view permission. Used by
 * the app shell to decide whether to render the Marketing nav link, and
 * by the marketing layout to decide whether to bounce.
 */
export function hasAnyMarketingView(
  perms: Pick<
    Record<MarketingPermissionKey, boolean>,
    | "canMarketingTemplatesView"
    | "canMarketingListsView"
    | "canMarketingCampaignsView"
    | "canMarketingSuppressionsView"
    | "canMarketingReportsView"
    | "canMarketingAuditView"
  >,
): boolean {
  return (
    perms.canMarketingTemplatesView ||
    perms.canMarketingListsView ||
    perms.canMarketingCampaignsView ||
    perms.canMarketingSuppressionsView ||
    perms.canMarketingReportsView ||
    perms.canMarketingAuditView
  );
}

/**
 * Returns the bundle name whose permission set exactly matches the user's
 * marketing permissions, or `"custom"` when no bundle matches. Used by the
 * RoleBundleSelector to pre-select the dropdown.
 */
export function detectBundle(
  perms: Record<RoleBundlePermissionKey, boolean>,
): MarketingRoleBundle | "custom" {
  for (const name of Object.keys(ROLE_BUNDLES) as MarketingRoleBundle[]) {
    if (permsMatchBundle(perms, name)) return name;
  }
  return "custom";
}

function permsMatchBundle(
  perms: Record<RoleBundlePermissionKey, boolean>,
  bundle: MarketingRoleBundle,
): boolean {
  const expected = resolveBundle(bundle);
  for (const key of ALL_MARKETING_KEYS) {
    if (Boolean(perms[key]) !== Boolean(expected[key])) return false;
  }
  return true;
}
