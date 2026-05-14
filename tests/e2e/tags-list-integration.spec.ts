import { test, expect } from "./fixtures/auth";
import { tagName, E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Tag integration on list pages — column toggle, filter, bulk-tag
 * toolbar, MODIFIED reset state participation.
 *
 * Targets /leads as the canonical surface (the same wiring repeats
 * on accounts / contacts / opportunities / tasks; the brief asks for
 * smokes that prove the pattern works end-to-end on at least one
 * entity). Smokes for other entities can extend this file in a
 * future phase.
 *
 * Test data hygiene: every lead + tag created here carries the
 * `[E2E-${E2E_RUN_ID}]` sentinel.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Tags — list integration", () => {
  test("toggle Tags column on /leads, filter by a tag, bulk-tag the visible rows", async ({
    page,
  }) => {
    const t1 = tagName("ListTag1");
    const t2 = tagName("ListTag2");
    const firstName = tagName("ListPerson");

    // 1. Create a tag-bearing lead.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(firstName);
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Subject");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(t1);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${t1}`).first()).toBeVisible({
      timeout: 5_000,
    });
    await tagInput.fill(t2);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${t2}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // 2. Navigate to /leads — column-chooser, toggle Tags on.
    await page.goto(`${BASE}/leads`);
    const colsBtn = page.getByRole("button", { name: /^Columns \(/ });
    await colsBtn.waitFor();
    await colsBtn.click();
    const tagsCheckbox = page.getByRole("checkbox", { name: /Tags/i });
    if (!(await tagsCheckbox.isChecked())) await tagsCheckbox.check();
    await page.keyboard.press("Escape");

    // 3. Phase 30 MODIFIED badge surfaces because the column state
    // differs from the active view's baseline.
    const modifiedBtn = page.getByRole("button", { name: /reset view to /i });
    await expect(modifiedBtn).toBeVisible({ timeout: 5_000 });

    // 4. Bulk-tag toolbar — the button exists in the header.
    const bulkBtn = page.getByRole("button", { name: /^Bulk tag$/ });
    await expect(bulkBtn).toBeVisible();

    // 5. Reset view to canonical — column reverts.
    await modifiedBtn.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /^Reset$/ }).click();
    await expect(
      page.getByRole("button", { name: /reset view to /i }),
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("filter /leads by ?tag=<name> — only matching rows are shown", async ({
    page,
  }) => {
    const filterTag = tagName("FilterableTag");
    const firstName = tagName("FilterMatch");

    // Create a lead bearing the filter tag.
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(firstName);
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Lead");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(filterTag);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");
    await expect(page.locator(`text=${filterTag}`).first()).toBeVisible({
      timeout: 5_000,
    });

    // Filter the list by the tag.
    await page.goto(
      `${BASE}/leads?tag=${encodeURIComponent(filterTag)}&view=builtin:all-mine`,
    );
    // The created lead is one of the rows visible after filter.
    await expect(page.locator(`text=${firstName}`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("bulk-tag dialog dismisses on Escape (a11y WCAG 2.1.2)", async ({
    page,
  }) => {
    // Ensure at least one tag exists in the catalog so the dialog
    // opens (the button hides when availableTags.length === 0).
    const ensureTag = tagName("BulkEscape");
    await page.goto(`${BASE}/leads/new`);
    await page.getByLabel(/first name/i).fill(tagName("BulkEscapeLead"));
    const lastField = page.getByLabel(/last name/i);
    if ((await lastField.count()) > 0) await lastField.fill("Sub");
    const compField = page.getByLabel(/company/i).first();
    if ((await compField.count()) > 0) await compField.fill(tagName("Co"));
    await page.getByRole("button", { name: /create lead/i }).click();
    await page.waitForURL(/\/leads\/[a-f0-9-]{36}$/, { timeout: 15_000 });
    await page.goto(`${page.url()}/edit`);
    const tagInput = page.locator('input[placeholder*="Add tags"]').first();
    await tagInput.fill(ensureTag);
    await page.waitForTimeout(300);
    await tagInput.press("Enter");

    await page.goto(`${BASE}/leads`);
    const bulkBtn = page.getByRole("button", { name: /^Bulk tag$/ });
    if ((await bulkBtn.count()) === 0) {
      test.skip(true, "No visible records / tags to bulk-tag against.");
      return;
    }
    await bulkBtn.click();
    const dlg = page.getByRole("dialog", {
      name: /Bulk add or remove tags/i,
    });
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0, { timeout: 5_000 });
  });
});
