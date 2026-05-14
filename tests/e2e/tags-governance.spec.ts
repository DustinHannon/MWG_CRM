import { test, expect } from "./fixtures/auth";
import { tagName, E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Tag governance smokes — open the TagEditModal from a chip body,
 * rename, recolour, and delete tags. Runs across all four Playwright
 * projects.
 *
 * Single-account constraint: tests run as `croom` (admin). For the
 * permission-gating test, the modal-open expectation is asserted under
 * the assumption that admin always gets `canManageTagDefinitions`. A
 * future Phase 32.7+ multi-account fixture could test the read-only
 * branch with a non-admin viewer; today that read-only branch is
 * already exercised at the unit level by `<TagSectionClient>` rendering
 * a flat chip list when both perms are false.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Tags — governance surface", () => {
  test("open the edit modal from a chip body, rename the tag, verify the new name surfaces on the record", async ({
    page,
  }) => {
    const original = tagName("RenameMe");
    const renamed = tagName("Renamed");

    // 1. Create a lead and tag it.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(tagName("Govern"));
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Lead");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    const leadEdit = `${page.url()}/edit`;
    await page.goto(leadEdit);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(original);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${original}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // 2. Click the chip body (NOT the × button) to open the edit modal.
    const chip = page.getByRole("button", {
      name: new RegExp(`^Edit tag ${escapeRegex(original)}$`),
    });
    await expect(chip).toBeVisible();
    await chip.click();

    // 3. The modal mounts with the tag name in the rename field.
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/^Edit tag$/i).first()).toBeVisible();

    // 4. Clear the name input and type the new name, then click Rename.
    const nameInput = modal.locator('input[type="text"]').first();
    await nameInput.fill(renamed);
    await modal.getByRole("button", { name: /^Rename$/ }).click();

    // 5. Wait for the toast confirmation; close the modal.
    await expect(page.getByText(/tag renamed/i)).toBeVisible({ timeout: 5_000 });
    await modal.getByRole("button", { name: /^Close$/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 6. The chip on the record reflects the new name.
    await expect(page.locator(`text=${renamed}`).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(`text=${original}`)).toHaveCount(0);
  });

  test("change a tag colour from the picker — verify the chip rerenders with the new background", async ({
    page,
  }) => {
    const label = tagName("ColorChange");

    // 1. Create a lead and tag it.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(tagName("Color"));
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Lead");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(label);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${label}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // 2. Open the edit modal.
    await page.getByRole("button", {
      name: new RegExp(`^Edit tag ${escapeRegex(label)}$`),
    }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    // 3. Pick the `green` swatch and apply.
    await modal.getByRole("button", { name: /^Use green colour$/ }).click();
    await modal.getByRole("button", { name: /^Save colour$/ }).click();

    // 4. Toast.
    await expect(page.getByText(/tag colour updated/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test("delete a tag globally — confirm dialog + verify chip disappears", async ({
    page,
  }) => {
    const label = tagName("DeleteMe");

    // 1. Tag a lead.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(tagName("Del"));
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Lead");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(label);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${label}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // 2. Open edit modal.
    await page.getByRole("button", {
      name: new RegExp(`^Edit tag ${escapeRegex(label)}$`),
    }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();

    // 3. Click "Delete tag" → confirm in nested AlertDialog.
    await modal.getByRole("button", { name: /^Delete tag$/ }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog).toBeVisible();
    await confirmDialog
      .getByRole("button", { name: /^Delete tag$/ })
      .click();

    // 4. Toast + chip disappears.
    await expect(page.getByText(/tag deleted/i)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(`text=${label}`)).toHaveCount(0, {
      timeout: 5_000,
    });
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
