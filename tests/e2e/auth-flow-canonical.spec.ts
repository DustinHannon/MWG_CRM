import { expect, test } from "@playwright/test";

/**
 * Phase 31 — confirms the auth flow lands on the canonical host. The
 * Playwright session is already authenticated via global-setup which
 * also runs against the canonical host (see playwright.config.ts
 * baseURL). This test exercises the post-cutover happy path: load
 * /dashboard at the canonical URL and confirm the cookie is honoured.
 */

test.describe("Phase 31 — auth on canonical host", () => {
  test("authenticated user reaches /dashboard at canonical host", async ({ page }) => {
    const res = await page.goto("/dashboard");
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/crm\.morganwhite\.com\/dashboard/);
  });

  test("public health endpoint reachable at canonical host", async ({ request }) => {
    const res = await request.get("/api/health");
    expect([200, 503]).toContain(res.status());
  });
});
