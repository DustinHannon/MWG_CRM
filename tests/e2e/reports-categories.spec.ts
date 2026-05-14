import { test, expect } from "./fixtures/auth";

/**
 * Phase 27 §7 — Phase 24 §6 / Phase 25 §0 #2 deferred spec.
 *
 * /reports built-in catalog renders into expandable category
 * sections (`src/lib/reports/categories.ts`). The order is fixed:
 *   Leads → Accounts & Contacts → Opportunities → Tasks → Activities
 *   → Marketing & Email
 *
 * Empty categories are dropped server-side; this spec asserts the
 * surviving section headings render in canonical order on a real
 * production page load. Marketing-entity reports are gated to admins
 * with canManageMarketing — the cached storage-state user (`croom`)
 * is an admin, so Marketing should appear. If the storage-state
 * user changes to a non-admin, the Marketing assertion would need
 * to be conditional.
 */

test.describe("Phase 24 — /reports category catalog", () => {
  test("category sections render with stable order", async ({ page }) => {
    const res = await page.goto("/reports");
    expect(res?.status()).toBe(200);

    // The "Built-in reports" parent heading is on the page.
    await expect(
      page.getByRole("heading", { name: /Built-in reports/i }),
    ).toBeVisible();

    // Each category renders its label. We use getByText with first()
    // because the CategorySection client component is the source of
    // truth for the visible label.
    await expect(page.getByText(/^Leads$/).first()).toBeVisible();
    await expect(
      page.getByText(/^Accounts & Contacts$/).first(),
    ).toBeVisible();
    await expect(page.getByText(/^Opportunities$/).first()).toBeVisible();
    await expect(page.getByText(/^Tasks$/).first()).toBeVisible();
    await expect(page.getByText(/^Activities$/).first()).toBeVisible();

    // Marketing section depends on perms. Use a soft-skip if absent
    // (croom is admin so this should always show in the prod fixture).
    const marketing = page.getByText(/^Marketing & Email$/).first();
    await expect(marketing).toBeVisible();
  });

  test("category labels appear in source-of-truth order", async ({ page }) => {
    await page.goto("/reports");
    const expectedOrder = [
      "Leads",
      "Accounts & Contacts",
      "Opportunities",
      "Tasks",
      "Activities",
    ];
    // Pull all rendered category labels and assert their relative
    // ordering in the DOM matches the catalog.
    const labels = await page
      .locator('text=/^(Leads|Accounts & Contacts|Opportunities|Tasks|Activities|Marketing & Email)$/')
      .allTextContents();
    // Filter to the set we expect, preserving order.
    const observed = labels.filter((l) => expectedOrder.includes(l));
    // Each expected label appears at least once; their relative order
    // matches the catalog. We compare first-occurrence indices.
    const firstIndex = (needle: string) => observed.indexOf(needle);
    for (let i = 1; i < expectedOrder.length; i++) {
      const prev = firstIndex(expectedOrder[i - 1]);
      const cur = firstIndex(expectedOrder[i]);
      expect(prev).toBeGreaterThanOrEqual(0);
      expect(cur).toBeGreaterThan(prev);
    }
  });

  test("'Your reports & shared' section header renders", async ({ page }) => {
    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /Your reports & shared/i }),
    ).toBeVisible();
  });

  test("'New report' CTA is visible", async ({ page }) => {
    await page.goto("/reports");
    await expect(
      page.getByRole("link", { name: /New report/i }),
    ).toBeVisible();
  });
});
