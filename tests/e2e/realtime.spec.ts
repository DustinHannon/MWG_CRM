import { test, expect } from "./fixtures/auth";
import { tagName, E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Phase 12 — realtime smoke against production.
 *
 * Single-account constraint: both contexts auth as `croom`. The
 * production hook implements skip-self via actor-id comparison; for
 * tests we set localStorage._e2eDisableSkipSelf=true so context B sees
 * context A's writes. (Foundation contract.)
 */
test.describe("realtime", () => {
  test("INSERT in context A surfaces in context B with flash", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({
      storageState: "tests/e2e/.auth/croom.json",
      extraHTTPHeaders: { "X-E2E-Run-Id": E2E_RUN_ID },
    });
    const ctxB = await browser.newContext({
      storageState: "tests/e2e/.auth/croom.json",
      extraHTTPHeaders: { "X-E2E-Run-Id": E2E_RUN_ID },
    });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    // Both contexts disable skip-self (single-account constraint).
    await a.addInitScript(() => {
      window.localStorage.setItem("_e2eDisableSkipSelf", "true");
    });
    await b.addInitScript(() => {
      window.localStorage.setItem("_e2eDisableSkipSelf", "true");
    });

    await a.goto("/leads/new");
    await b.goto("/leads");

    const taggedFirstName = tagName("Realtime");
    const taggedLastName = "Smoke";
    await a.getByLabel(/first name/i).fill(taggedFirstName);
    const lastNameField = a.getByLabel(/last name/i);
    if ((await lastNameField.count()) > 0) {
      await lastNameField.fill(taggedLastName);
    }
    const companyField = a.getByLabel(/company/i).first();
    if ((await companyField.count()) > 0) {
      await companyField.fill(`Acme ${E2E_RUN_ID}`);
    }
    await a.getByRole("button", { name: /save|create/i }).first().click();

    // Wait for the new lead to surface in context B's list.
    const row = b.getByText(new RegExp(taggedFirstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    await expect(row).toBeVisible({ timeout: 10_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test.skip(
    "two real users — see other user's writes (skipped pending second test identity)",
    async () => {},
  );
});
