import { test, expect } from "@playwright/test";

/**
 * Marketing suppressions add/remove flows. Runs across desktop and
 * both mobile projects. Pre-conditions: the signed-in user is admin
 * (so Add + Remove are both visible). A non-admin run path is
 * exercised via the meta-tests in admin-user-permissions.spec.ts —
 * filesystem-level enforcement assertion.
 *
 * Test data uses the `[E2E-${runId}]` sentinel pattern so cleanup is
 * safe even if a run aborts mid-flow.
 */

function makeRunId(): string {
  return `E2E-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

test.describe("marketing suppressions — admin", () => {
  test("admin sees Add suppression button", async ({ page }) => {
    await page.goto("/marketing/suppressions");
    await expect(
      page.getByRole("button", { name: /Add suppression/ }),
    ).toBeVisible();
  });

  test("add → list → remove a manual suppression with reason", async ({
    page,
  }) => {
    const runId = makeRunId();
    const testEmail = `suppress-test+${runId.toLowerCase()}@example.invalid`;

    await page.goto("/marketing/suppressions?source=manual");
    await page.getByRole("button", { name: /Add suppression/ }).click();

    // Dialog opens. Fill the form.
    const emailInput = page.locator("input[name='email']");
    const reasonInput = page.locator("textarea[name='reason']");
    await expect(emailInput).toBeVisible();
    await emailInput.fill(testEmail);
    await reasonInput.fill(`[${runId}] Adversarial test add.`);

    // Submit.
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect(page.getByText("Suppression added.")).toBeVisible({
      timeout: 5000,
    });

    // Row now appears in the table (filter on manual to narrow).
    await page.goto("/marketing/suppressions?source=manual");
    // post-migration the row is a div in a virtualized
    // feed. Match the row by the email text in any descendant of the
    // [role=feed] container, then walk up to the row-level element so the
    // .getByRole inside it picks up the Remove button.
    const row = page
      .locator(`[role="feed"] >> text=${testEmail}`)
      .locator("xpath=ancestor::*[@data-row-flash][1]");
    await expect(row).toBeVisible();

    // Source column shows "manual" and Added by shows the admin's name
    // (not "system"). The test doesn't pin the admin name string but
    // asserts the row does not render the literal "system" italic
    // placeholder (which only renders when added_by_user_id IS NULL).
    await expect(row).toContainText("manual");
    await expect(row.locator("text=system")).toHaveCount(0);

    // Remove flow: open dialog, type reason, confirm.
    await row.getByRole("button", { name: /Remove suppression/ }).click();
    const removeReason = page.locator("textarea[id^='remove-reason-']");
    await expect(removeReason).toBeVisible();
    await removeReason.fill(`[${runId}] Adversarial test remove.`);
    await page.getByRole("button", { name: /^Remove$/ }).click();
    await expect(page.getByText("Suppression removed.")).toBeVisible({
      timeout: 5000,
    });

    // Row is gone.
    await page.goto("/marketing/suppressions?source=manual");
    await expect(
      page.locator(`[role="feed"] >> text=${testEmail}`),
    ).toHaveCount(0);
  });

  test("adding a duplicate email surfaces a friendly error", async ({
    page,
  }) => {
    const runId = makeRunId();
    const testEmail = `dupe-test+${runId.toLowerCase()}@example.invalid`;

    await page.goto("/marketing/suppressions");
    // First add.
    await page.getByRole("button", { name: /Add suppression/ }).click();
    await page.locator("input[name='email']").fill(testEmail);
    await page
      .locator("textarea[name='reason']")
      .fill(`[${runId}] First add for dedup test.`);
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect(page.getByText("Suppression added.")).toBeVisible({
      timeout: 5000,
    });

    // Second add of the same email.
    await page.getByRole("button", { name: /Add suppression/ }).click();
    await page.locator("input[name='email']").fill(testEmail);
    await page
      .locator("textarea[name='reason']")
      .fill(`[${runId}] Duplicate add — should fail.`);
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: /already suppressed/i }),
    ).toBeVisible({ timeout: 5000 });

    // Cleanup: dismiss the dialog, then remove the row added in step 1.
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await page.goto("/marketing/suppressions?source=manual");
    // post-migration the row is a div in a virtualized
    // feed. Match the row by the email text in any descendant of the
    // [role=feed] container, then walk up to the row-level element so the
    // .getByRole inside it picks up the Remove button.
    const row = page
      .locator(`[role="feed"] >> text=${testEmail}`)
      .locator("xpath=ancestor::*[@data-row-flash][1]");
    if (await row.count()) {
      await row.getByRole("button", { name: /Remove suppression/ }).click();
      await page
        .locator("textarea[id^='remove-reason-']")
        .fill(`[${runId}] Cleanup after dedup test.`);
      await page.getByRole("button", { name: /^Remove$/ }).click();
      await expect(page.getByText("Suppression removed.")).toBeVisible({
        timeout: 5000,
      });
    }
  });
});

test.describe("marketing suppressions — mobile", () => {
  test("Add dialog reachable on mobile viewport", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-only test");
    await page.goto("/marketing/suppressions");
    const button = page.getByRole("button", { name: /Add suppression/ });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
