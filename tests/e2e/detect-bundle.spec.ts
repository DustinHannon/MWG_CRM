import { test, expect } from "@playwright/test";
import {
  ALL_MARKETING_KEYS,
  ROLE_BUNDLES,
  detectBundle,
  resolveBundle,
  type MarketingRoleBundle,
} from "@/lib/permissions/role-bundles";
import type { PermissionKey } from "@/lib/auth-helpers";

/**
 * Unit-style coverage for `detectBundle` and `resolveBundle`. Runs
 * inside the Playwright test runner because the project has no
 * separate unit-test harness. Filesystem and browser are not used.
 */

function buildFullPermsFromBundle(
  bundle: MarketingRoleBundle,
): Record<PermissionKey, boolean> {
  // Start with every PermissionKey false, then overlay bundle truthies.
  const base = {} as Record<PermissionKey, boolean>;
  for (const k of ALL_MARKETING_KEYS) base[k] = false;
  // Non-marketing PermissionKeys default false too; they don't affect detect.
  const overlay = resolveBundle(bundle);
  for (const k of ALL_MARKETING_KEYS) base[k] = overlay[k];
  return base;
}

test.describe("detectBundle", () => {
  test.skip(
    () => test.info().project.name !== "desktop-chromium",
    "logic check runs once on desktop project",
  );

  for (const name of Object.keys(ROLE_BUNDLES) as MarketingRoleBundle[]) {
    test(`returns "${name}" for the exact bundle preset`, () => {
      const perms = buildFullPermsFromBundle(name);
      expect(detectBundle(perms)).toBe(name);
    });
  }

  test("returns custom when perms diverge from every bundle", () => {
    const perms = buildFullPermsFromBundle("marketing_viewer");
    // Tip one extra key on — no longer matches viewer or any other bundle.
    perms.canMarketingCampaignsSendNow = true;
    expect(detectBundle(perms)).toBe("custom");
  });

  test("returns custom for the all-false starting state", () => {
    const perms = {} as Record<PermissionKey, boolean>;
    for (const k of ALL_MARKETING_KEYS) perms[k] = false;
    // viewer needs ANY view perm on — all-false doesn't match viewer.
    expect(detectBundle(perms)).toBe("custom");
  });
});

test.describe("resolveBundle", () => {
  test.skip(
    () => test.info().project.name !== "desktop-chromium",
    "logic check runs once on desktop project",
  );

  test("marketing_admin grants every marketing key", () => {
    const perms = resolveBundle("marketing_admin");
    for (const k of ALL_MARKETING_KEYS) {
      expect(perms[k]).toBe(true);
    }
  });

  test("marketing_sender grants send + views but not authoring", () => {
    const perms = resolveBundle("marketing_sender");
    expect(perms.canMarketingCampaignsSendNow).toBe(true);
    expect(perms.canMarketingTemplatesView).toBe(true);
    expect(perms.canMarketingTemplatesCreate).toBe(false);
    expect(perms.canMarketingCampaignsCreate).toBe(false);
  });

  test("marketing_viewer grants every view perm and nothing else", () => {
    const perms = resolveBundle("marketing_viewer");
    expect(perms.canMarketingTemplatesView).toBe(true);
    expect(perms.canMarketingListsView).toBe(true);
    expect(perms.canMarketingCampaignsView).toBe(true);
    expect(perms.canMarketingSuppressionsView).toBe(true);
    expect(perms.canMarketingReportsView).toBe(true);
    expect(perms.canMarketingAuditView).toBe(true);
    expect(perms.canMarketingTemplatesCreate).toBe(false);
    expect(perms.canMarketingCampaignsSendNow).toBe(false);
  });
});
