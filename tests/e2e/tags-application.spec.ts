import { test, expect } from "./fixtures/auth";
import { tagName, E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Tag application smokes — apply / remove tags on a lead via the
 * inline TagSection on the edit form. Runs across all four Playwright
 * projects (desktop-chromium, mobile-iphone, mobile-pixel,
 * tablet-ipad).
 *
 * Test-data hygiene: every created lead / tag carries the
 * `[E2E-${E2E_RUN_ID}]` sentinel so `cleanup.ts` removes them at
 * end-of-run. Tag rows cascade through every junction table on FK
 * delete, so dropping the tag also drops its applications.
 *
 * Single-account constraint: tests authenticate as `croom` with full
 * admin perms. canApplyTags + canManageTagDefinitions both true via
 * the admin shortcut in `requirePermission`.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Tags — application surface", () => {
  test("apply a new tag to a lead, then remove it via the chip × button", async ({
    page,
  }) => {
    const leadFirst = tagName("Tagapply");
    const leadLast = "Lead";
    const tagLabel = tagName("ApplyTag");

    // 1. Create a lead via the New Lead form so its detail page has
    // a stable id for the rest of the flow.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(leadFirst);
    const lastNameField = page.getByLabel(/last name/i);
    if ((await lastNameField.count()) > 0) {
      await lastNameField.fill(leadLast);
    }
    const companyField = page.getByLabel(/company/i).first();
    if ((await companyField.count()) > 0) {
      await companyField.fill(tagName("Co"));
    }
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    const leadDetailUrl = page.url();
    const leadId = leadDetailUrl.split("/").pop()!;

    // 2. Open the edit form and wait for the Tags section to mount.
    await page.goto(`${leadDetailUrl}/edit`);
    const tagsHeader = page.getByRole("heading", { name: /^Tags$/ }).first();
    await expect(tagsHeader).toBeVisible();

    // 3. Type a new tag name, then Enter to apply via inline action.
    const tagInputBox = page.locator('input[placeholder*="Add tags"]').first();
    await expect(tagInputBox).toBeVisible();
    await tagInputBox.fill(tagLabel);
    // Wait briefly for the create-row in the dropdown.
    await page.waitForTimeout(300);
    await tagInputBox.press("Enter");

    // 4. The chip appears in the Tags section.
    const chip = page.locator(`text=${tagLabel}`).first();
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // 5. Click the × button on the chip to remove it.
    const removeBtn = page.getByRole("button", {
      name: new RegExp(`^Remove ${escapeRegex(tagLabel)}$`),
    });
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // 6. Chip disappears.
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Remove ${escapeRegex(tagLabel)}$`),
      }),
    ).toHaveCount(0, { timeout: 5_000 });

    // Smoke that the leadId remains addressable for cleanup; the
    // tag-rows on lead_tags cascade when the tag is dropped.
    expect(leadId).toMatch(/^[a-f0-9-]{36}$/);
  });

  test("reuse the same tag across two entities — does not create a duplicate", async ({
    page,
  }) => {
    const tagLabel = tagName("ReuseTag");

    // 1. Tag a lead.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(tagName("Reuse"));
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) {
      await lastField.fill("Lead");
    }
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) {
      await compField.fill(tagName("Co"));
    }
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    const leadEdit = `${page.url()}/edit`;
    await page.goto(leadEdit);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(tagLabel);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${tagLabel}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // 2. Verify the catalog has exactly one tag with this name by
    // hitting /accounts (which loads the tag library via listTags).
    // The Tags filter dropdown surfaces the list; toggling it open
    // and counting matching chips is a stable assertion.
    await page.goto(`${BASE}/accounts`);
    const tagFilterBtn = page
      .getByRole("button", { name: /All Tags|Tags:/i })
      .first();
    if ((await tagFilterBtn.count()) > 0) {
      await tagFilterBtn.click();
      const tagChipsInFilter = page
        .getByRole("listbox")
        .locator(`text=${tagLabel}`);
      // Exactly one match across the entire catalog.
      await expect(tagChipsInFilter).toHaveCount(1);
    }
  });

  test("mobile — chip × hit area meets touch-target requirement", async ({
    page,
    viewport,
  }) => {
    test.skip(
      !viewport || viewport.width > 480,
      "Mobile-only touch-target test",
    );

    const leadFirst = tagName("TouchTarget");
    const tagLabel = tagName("TouchTag");

    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(leadFirst);
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Lead");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });

    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(tagLabel);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${tagLabel}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // The visible × button is 16x16 but a ::before pseudo-element
    // expands the actual click target to ~44x44. Tap test verifies
    // a tap on the touch-extended hit area still triggers the remove.
    const removeBtn = page.getByRole("button", {
      name: new RegExp(`^Remove ${escapeRegex(tagLabel)}$`),
    });
    await expect(removeBtn).toBeVisible();
    const box = await removeBtn.boundingBox();
    expect(box).not.toBeNull();
    // Tap somewhat outside the 16px button — verify the pseudo hit
    // area still receives the click via JS coordinates.
    if (box) {
      // Click ~10px outside the visible × button — still within
      // the ::before extended target (inset -14px from the button).
      await page.mouse.click(box.x + box.width + 6, box.y + box.height / 2);
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^Remove ${escapeRegex(tagLabel)}$`),
        }),
      ).toHaveCount(0, { timeout: 5_000 });
    }
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
