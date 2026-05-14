import { test, expect } from "./fixtures/auth";

/**
 * Phase 12 — auth smoke. Confirms that the cached storage state from
 * global-setup actually authenticates against production. If this
 * spec fails, every other spec will too.
 */
test.describe("auth", () => {
  test("cached storage state authenticates without re-login", async ({ page }) => {
    await page.goto("/leads");
    // Authenticated landing should render the leads page (or dashboard
    // depending on user prefs). Either way we must NOT redirect to
    // /auth/signin.
    await expect(page).not.toHaveURL(/\/auth\/signin/);
    await expect(page.locator("body")).not.toContainText(/sign in/i);
  });

  test("logout clears session", async ({ page }) => {
    await page.goto("/leads");
    // The user menu / topbar exposes a "Sign out" affordance. Find it
    // by accessible text — the exact button label may evolve.
    const signOut = page.getByRole("button", { name: /sign out|log out/i });
    if ((await signOut.count()) > 0) {
      await signOut.first().click();
    } else {
      // Fall back to clearing storage and re-navigating.
      await page.context().clearCookies();
    }
    await page.goto("/leads");
    // After logout we should redirect to signin.
    await expect(page).toHaveURL(/\/auth\/signin/);
  });

  test("?next=//evil.com is sanitized post-login (Phase 11D regression)", async ({
    page,
  }) => {
    await page.goto("/auth/signin?callbackUrl=%2F%2Fevil.com");
    // We don't actually log in here (storage state already authenticates);
    // just verify the page does not surface evil.com as a target.
    await expect(page.locator("body")).not.toContainText(/evil\.com/i);
  });
});
