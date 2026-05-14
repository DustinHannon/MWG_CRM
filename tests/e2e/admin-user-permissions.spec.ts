import { test, expect } from "@playwright/test";

/**
 * Admin user-permissions page coverage.
 *
 * Runs against the rebuilt collapsible-category-table UI. The desktop
 * suite verifies the save+audit flow and role-bundle apply; the mobile
 * suites (mobile-iphone, mobile-pixel) add touch-target and
 * viewport-overflow checks.
 *
 * Pre-conditions: the signed-in user must be an admin. The first user
 * row on /admin/users is used as the target so the spec is robust
 * against test-account churn.
 */

const PROJECT = test.info;

async function gotoFirstUser(page: import("@playwright/test").Page) {
  await page.goto("/admin/users");
  // Click the first user link in the table.
  const firstLink = page.locator("a[href^='/admin/users/']").first();
  await firstLink.waitFor({ state: "visible" });
  await firstLink.click();
  await page.waitForURL(/\/admin\/users\/[^/]+$/);
}

test.describe("admin user permissions", () => {
  test("page renders collapsible categories with grant-count badges", async ({
    page,
  }) => {
    await gotoFirstUser(page);

    // Every category renders a collapsible header. Spot-check three.
    for (const category of [
      "records",
      "marketing-templates",
      "marketing-campaigns",
    ]) {
      const header = page.locator(
        `[id="admin-perm-category-${category}-header"]`,
      );
      await expect(header).toBeVisible();
      // Badge format "N / total".
      await expect(header).toContainText(/\d+ \/ \d+/);
    }
  });

  test("expanding a category reveals toggles", async ({ page }) => {
    await gotoFirstUser(page);

    const header = page.locator(
      "[id='admin-perm-category-marketing-templates-header']",
    );
    const body = page.locator(
      "[id='admin-perm-category-marketing-templates-body']",
    );

    // Body hidden initially.
    await expect(body).toBeHidden();

    await header.click();
    await expect(body).toBeVisible();

    // Each marketing-template permission renders one switch.
    const switches = body.locator("[role='switch']");
    await expect(switches).toHaveCount(5);
  });

  test("save reflects toggled permission after reload", async ({ page }) => {
    await gotoFirstUser(page);

    // Expand the marketing-templates category and grab the View toggle.
    await page
      .locator("[id='admin-perm-category-marketing-templates-header']")
      .click();
    const viewToggle = page.locator(
      "[data-permission='canMarketingTemplatesView'] [role='switch']",
    );
    await expect(viewToggle).toBeVisible();
    const initialChecked = await viewToggle.getAttribute("aria-checked");

    // Toggle, save, reload, assert persisted.
    await viewToggle.click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page
      .locator("[id='admin-perm-category-marketing-templates-header']")
      .click();

    const newChecked = await viewToggle.getAttribute("aria-checked");
    expect(newChecked).not.toBe(initialChecked);

    // Revert so subsequent runs start from the same state.
    await viewToggle.click();
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForLoadState("networkidle");
  });

  test("role-bundle selector shows 5 bundle options + custom", async ({
    page,
  }) => {
    await gotoFirstUser(page);
    const selector = page.locator("[data-testid='role-bundle-selector']");
    await expect(selector).toBeVisible();

    const select = selector.locator("select");
    const options = await select.locator("option").allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(6); // custom + 5 bundles
    expect(options.join(" ").toLowerCase()).toContain("viewer");
    expect(options.join(" ").toLowerCase()).toContain("campaigner");
    expect(options.join(" ").toLowerCase()).toContain("admin");
  });
});

test.describe("admin user permissions — mobile", () => {
  test("category headers meet 44px touch target on mobile", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "mobile-only test");
    await gotoFirstUser(page);

    const header = page.locator(
      "[id='admin-perm-category-marketing-campaigns-header']",
    );
    const box = await header.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("role bundle selector fits the mobile viewport", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "mobile-only test");
    await gotoFirstUser(page);

    const selector = page.locator("[data-testid='role-bundle-selector']");
    await expect(selector).toBeVisible();
    const box = await selector.boundingBox();
    const vp = page.viewportSize();
    expect(box && vp).toBeTruthy();
    if (box && vp) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    }
  });
});

/**
 * Meta-tests guard against the orphan-perm class returning + against
 * any stray canManageMarketing residual. Runs on a single project to
 * avoid duplicating identical filesystem checks.
 */
test.describe("permission-system meta-tests", () => {
  test.skip(
    () => PROJECT().project.name !== "desktop-chromium",
    "filesystem checks run once on desktop project",
  );

  test("zero canManageMarketing residual references in source", async () => {
    const { execSync } = await import("node:child_process");
    let stdout = "";
    try {
      stdout = execSync(
        "grep -rEn \"canManageMarketing|can_manage_marketing\" src/ --include='*.ts' --include='*.tsx' --include='*.sql'",
        { encoding: "utf-8", cwd: process.cwd() },
      );
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) {
        stdout = "";
      } else {
        throw e;
      }
    }
    expect(stdout.trim()).toBe("");
  });

  test("zero canViewTeamRecords residual references in source", async () => {
    const { execSync } = await import("node:child_process");
    let stdout = "";
    try {
      stdout = execSync(
        "grep -rEn \"canViewTeamRecords|can_view_team_records\" src/ --include='*.ts' --include='*.tsx' --include='*.sql'",
        { encoding: "utf-8", cwd: process.cwd() },
      );
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err.status === 1) {
        stdout = "";
      } else {
        throw e;
      }
    }
    expect(stdout.trim()).toBe("");
  });

  test("every former orphan permission has at least one enforcement reference", async () => {
    const { execSync } = await import("node:child_process");
    const FORMER_ORPHANS = [
      "canMarketingTemplatesView",
      "canMarketingTemplatesDelete",
      "canMarketingTemplatesSendTest",
      "canMarketingListsView",
      "canMarketingListsDelete",
      "canMarketingListsRefresh",
      "canMarketingSuppressionsAdd",
      "canMarketingSuppressionsRemove",
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
    ];

    const baselineFiles = new Set([
      "src/db/schema/users.ts",
      "src/lib/auth-helpers.ts",
      "src/lib/permissions/role-bundles.ts",
      "src/lib/permissions/ui-categories.ts",
    ]);

    for (const perm of FORMER_ORPHANS) {
      let stdout = "";
      try {
        stdout = execSync(
          `grep -rEln "${perm}" src/ --include='*.ts' --include='*.tsx'`,
          { encoding: "utf-8", cwd: process.cwd() },
        );
      } catch (e: unknown) {
        const err = e as { status?: number };
        if (err.status === 1) stdout = "";
        else throw e;
      }
      const allFiles = stdout
        .split(/\r?\n/)
        .map((p) => p.replace(/\\/g, "/").trim())
        .filter(Boolean);
      const enforcementFiles = allFiles.filter((p) => !baselineFiles.has(p));
      expect(
        enforcementFiles,
        `Permission ${perm} has no enforcement file outside the baseline definitions.`,
      ).not.toEqual([]);
    }
  });
});
