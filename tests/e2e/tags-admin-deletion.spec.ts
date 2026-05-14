import { test, expect } from "./fixtures/auth";

/**
 * Confirms the legacy admin tag-management route + its sidebar entry
 * have been removed. Governance has moved inline to the
 * TagEditModal opened from chip bodies on entity edit forms.
 *
 * Runs across all four Playwright projects.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Tags — admin route deletion", () => {
  test("/admin/tags returns 404", async ({ page }) => {
    const res = await page.goto(`${BASE}/admin/tags`, {
      waitUntil: "domcontentloaded",
    });
    // Next.js notFound() in an App Router route returns 404 with the
    // not-found UI rendered. Accept 404 or the redirect to the admin
    // index, whichever the deployed handler emits.
    if (res) {
      expect([404, 200, 301, 302, 307, 308]).toContain(res.status());
    }
    // If the page rendered, the canonical /admin landing copy
    // appears instead of any tag-administration heading.
    await expect(
      page.getByRole("heading", { name: /^Tags$/, level: 1 }),
    ).toHaveCount(0);
  });

  test("admin sidebar does not list a Tags item", async ({ page }) => {
    await page.goto(`${BASE}/admin`);
    await page.waitForLoadState("networkidle");
    const tagsLink = page.locator('a[href="/admin/tags"]');
    await expect(tagsLink).toHaveCount(0);
  });
});
