import { test, expect } from "./fixtures/auth";

/**
 * Saved-view reset smoke for both /leads and /tasks.
 *
 * The MODIFIED badge is a clickable button (rounded-full pill,
 * priority-medium colors) that opens a confirmation dialog and
 * resets the view's URL state on confirm. Both pages share the
 * `<ModifiedBadge>` component from `@/components/saved-views`. The
 * aria-label is `Reset view to ${savedViewName}` so screen readers
 * announce which view will be restored.
 *
 * Single-account constraint: tests run as `croom` against
 * production. The reset action navigates to `/<page>?view=<id>` with
 * no other params, which the page re-derives from the saved/built-in
 * view definition.
 */
test.describe("Saved-view reset", () => {
  test("Leads: MODIFIED badge resets view to its saved definition", async ({
    page,
  }) => {
    await page.goto("/leads");

    // Wait for the toolbar to mount — the view selector is the canonical
    // anchor (built-in "My Open Leads" is the default fallback view).
    await page
      .getByRole("button", { name: /My Open Leads|Pick a view/ })
      .first()
      .waitFor();

    // Modify columns: open the column chooser and toggle off the first
    // checkbox so we drift from the view's baseColumns.
    await page.getByRole("button", { name: /^Columns \(/ }).click();
    const firstCheckbox = page.getByRole("checkbox").first();
    await firstCheckbox.waitFor();
    await firstCheckbox.uncheck();
    await page.keyboard.press("Escape");

    // The MODIFIED button surfaces.
    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    // Click → confirm dialog opens.
    await modifiedBtn.click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Reset view?",
    );

    // Confirm.
    await page.getByRole("button", { name: /^Reset$/ }).click();

    // Badge disappears (URL reverted to ?view=<id> with no ?cols).
    await expect(
      page.getByRole("button", {
        name: /reset view to /i,
      }),
    ).toHaveCount(0);

    // Sonner toast confirms.
    await expect(page.getByText("View reset.")).toBeVisible();
  });

  test("Leads: Cancel keeps the modified state intact", async ({ page }) => {
    await page.goto("/leads");
    await page
      .getByRole("button", { name: /My Open Leads|Pick a view/ })
      .first()
      .waitFor();

    // Apply a URL search param to trigger viewModified without touching
    // columns. Covers the widened drift detection: ?q triggers reset.
    await page.goto("/leads?q=ZZZ_SAVED_VIEW_RESET_CANCEL_TEST");

    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    await modifiedBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: /^Cancel$/ }).click();

    // Badge still present — cancel didn't navigate.
    await expect(modifiedBtn).toBeVisible();
  });

  test("Tasks: MODIFIED badge resets view to its saved definition", async ({
    page,
  }) => {
    // Drive drift via URL — a status override differs from the default
    // built-in "My open tasks" view (which uses ['open','in_progress']).
    await page.goto("/tasks?status=completed");

    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    await modifiedBtn.click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Reset view?",
    );

    await page.getByRole("button", { name: /^Reset$/ }).click();

    // Badge disappears (URL reverted to ?view=<id> with no other params).
    await expect(
      page.getByRole("button", {
        name: /reset view to /i,
      }),
    ).toHaveCount(0);

    await expect(page.getByText("View reset.")).toBeVisible();
  });

  test("Tasks: Cancel keeps the modified state intact", async ({ page }) => {
    await page.goto("/tasks?q=ZZZ_SAVED_VIEW_TASKS_CANCEL");

    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    await modifiedBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: /^Cancel$/ }).click();

    // Badge still present — cancel didn't navigate.
    await expect(modifiedBtn).toBeVisible();
  });
});
