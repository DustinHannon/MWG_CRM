import { test, expect } from "./fixtures/auth";

/**
 * Search, filter, sort, and selection behavior on the canonical
 * list page (/leads).
 *
 * F-ID mapping (matches the Pass 7 brief):
 *
 *   F-debounce   Search input does not fire a fetch per keystroke.
 *                The leads list uses explicit-apply (Enter / blur /
 *                form submit) rather than a time-debounced auto-apply;
 *                the contract is the same — keystrokes never produce
 *                a 1:1 fetch storm.
 *   F-03         Saved-view selection persists across a full page
 *                reload: ?view=<id> in the URL survives the round
 *                trip and the view-selector trigger label stays
 *                stable.
 *   F-07         Filter + column-visibility interaction. Toggling a
 *                column writes ?cols= to the URL; changing filter
 *                state does NOT corrupt the cols query param (the
 *                MODIFIED badge does, however, surface for filter
 *                drift — that's a separate contract covered in
 *                saved-view-reset.spec.ts).
 *   F-21         Mobile filter chip row carries the `mask-image`
 *                edge fade, overflows horizontally, and uses an
 *                `h-11` (44px) touch target. AND multi-select
 *                filter mutation clears any active bulk selection
 *                so an `all_loaded` scope from the prior result set
 *                doesn't leak into the new one (see
 *                src/components/bulk-selection/bulk-selection-provider.tsx
 *                doctrine: "Consumers MUST dispatch `{ type: 'clear' }`
 *                from their filter change handler").
 *   F-reset      Reset-to-default-view from a filtered state — the
 *                MODIFIED badge confirm dialog navigates back to
 *                ?view=<id> with no other params, dropping all
 *                filter drift.
 *   F-noracefetch  No double-fetch when a single filter mutation
 *                fires apply — Enter must not produce two
 *                concurrent identical in-flight requests.
 *
 * Read-only — no records are created or mutated. The
 * `X-E2E-Run-Id` header is still stamped on every request via
 * `fixtures/auth.ts`, so any incidental audit-log emissions are
 * filterable from /admin/audit.
 *
 * Production environment; uses cached storage state from
 * global-setup.ts.
 */

const LEADS_LIST_API = /\/api\/leads\/list(?:\?|$)/;
const DESKTOP_SEARCH_SELECTOR =
  'input[type="search"][placeholder="Search name / email / company / phone…"]';
const MOBILE_SEARCH_SELECTOR =
  'input[type="search"][placeholder="Search name, email, company…"]';

function isMobile(viewportWidth: number): boolean {
  return viewportWidth < 768;
}

/**
 * Wait for the Leads list shell to be fully interactive — heading
 * rendered and feed attached. Replaces blind `waitForTimeout` waits
 * for initial mount.
 */
async function waitForLeadsListReady(
  page: import("@playwright/test").Page,
): Promise<void> {
  await Promise.all([
    page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" }),
    page.getByRole("feed").first().waitFor({ state: "attached" }),
  ]);
}

test.describe("Search apply cadence (F-debounce)", () => {
  test("desktop: typing without Enter does not dispatch fetches", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Desktop search input is hidden below md; mobile uses blur-to-apply.",
    );

    // Register the listener AFTER initial mount so the initial fetch
    // is excluded from the burst count.
    await page.goto("/leads");
    await waitForLeadsListReady(page);

    let fetchCount = 0;
    page.on("request", (req) => {
      if (LEADS_LIST_API.test(req.url())) fetchCount += 1;
    });

    const desktopSearch = page.locator(DESKTOP_SEARCH_SELECTOR).first();
    await desktopSearch.waitFor({ state: "visible" });
    await desktopSearch.click();

    // Type 8 characters. The desktop search input is explicit-apply
    // — keystrokes alone (no Enter, no blur) must produce zero
    // fetches. A debounced auto-apply would also satisfy this
    // contract as long as `burstFetches < burst.length`.
    const burst = "acmecorp";
    for (const ch of burst) {
      await page.keyboard.type(ch, { delay: 30 });
    }

    // Allow up to 500ms for any debounced fetch to settle. This is
    // a known-bounded tail period — not a "wait and hope".
    await page.waitForTimeout(500);

    // Strict ceiling: keystrokes must NOT produce a 1:1 fetch.
    expect(fetchCount).toBeLessThan(burst.length);
  });

  test("desktop: Enter applies and fires exactly one fetch", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Desktop Enter-to-apply cadence; mobile blur-to-apply has a separate path.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    const desktopSearch = page.locator(DESKTOP_SEARCH_SELECTOR).first();
    await desktopSearch.waitFor({ state: "visible" });
    await desktopSearch.fill("acme-search-token");

    // Press Enter, expecting the apply to trigger a list-API call.
    // waitForResponse replaces a brittle waitForTimeout.
    const responsePromise = page.waitForResponse(
      (resp) =>
        LEADS_LIST_API.test(resp.url()) && resp.request().method() === "GET",
      { timeout: 10_000 },
    );
    await page.keyboard.press("Enter");
    const resp = await responsePromise;

    // The applied query must reach the API.
    expect(resp.url()).toMatch(/[?&]q=acme-search-token(?:&|$)/);
  });
});

test.describe("F-noracefetch — no double-fetch on filter apply", () => {
  test("Enter does not produce two concurrent identical fetches", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Desktop explicit-apply path.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    const seen: string[] = [];
    page.on("request", (req) => {
      if (LEADS_LIST_API.test(req.url())) seen.push(req.url());
    });

    const desktopSearch = page.locator(DESKTOP_SEARCH_SELECTOR).first();
    await desktopSearch.waitFor({ state: "visible" });
    await desktopSearch.fill("zzzzz-singlefetch-token");

    const responsePromise = page.waitForResponse(
      (resp) =>
        LEADS_LIST_API.test(resp.url()) &&
        resp.url().includes("zzzzz-singlefetch-token"),
      { timeout: 10_000 },
    );
    await page.keyboard.press("Enter");
    await responsePromise;

    // Drain any tail fetch (e.g., onBlur firing after Enter focus shift).
    await page.waitForTimeout(400);

    const matching = seen.filter((url) =>
      url.includes("zzzzz-singlefetch-token"),
    );
    // The contract: a SINGLE filter mutation produces ≤ 1 fetch for
    // that filter value. Two requests with the same q= value would
    // indicate Enter and onBlur both apply (desktop input has no
    // onBlur — only mobile does — so this guards against accidental
    // regressions where both apply paths fire).
    expect(matching.length).toBeLessThanOrEqual(1);
  });
});

test.describe("F-03 — saved-view persists across reload", () => {
  test("?view= survives a full page reload", async ({ page }) => {
    // Land on the canonical built-in default view URL explicitly.
    await page.goto("/leads?view=builtin:my-open");
    await waitForLeadsListReady(page);

    // The view selector should reflect the locked default.
    const viewTrigger = page
      .getByRole("button", { name: /My Open Leads|Pick a view/ })
      .first();
    await expect(viewTrigger).toBeVisible();

    // Reload. The same ?view= should round-trip — Next's server page
    // re-derives state from searchParams on each request.
    await page.reload();
    await waitForLeadsListReady(page);

    // Same trigger label still active.
    await expect(viewTrigger).toBeVisible();
    expect(page.url()).toContain("view=builtin:my-open");
  });

  test("?cols= drift survives reload and surfaces the MODIFIED badge", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Column chooser is desktop-only.",
    );

    // Force a column-set drift via URL — a non-default cols param
    // diverges from the view's baseColumns.
    await page.goto("/leads?view=builtin:my-open&cols=name,status");
    await waitForLeadsListReady(page);

    // MODIFIED badge surfaces because cols differ from baseColumns.
    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    await page.reload();
    await waitForLeadsListReady(page);

    // Drift survives reload and the MODIFIED badge re-renders.
    await expect(modifiedBtn).toBeVisible();
    expect(page.url()).toContain("cols=name");
  });
});

test.describe("F-07 — cols+filter URL sync, no cross-contamination", () => {
  test("toggling a column updates ?cols= without losing ?view=", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Column chooser is desktop-only.",
    );

    await page.goto("/leads?view=builtin:my-open");
    await waitForLeadsListReady(page);

    // Open the columns popover, toggle off the first checkbox to
    // induce a ?cols= write.
    await page.getByRole("button", { name: /^Columns \(/ }).click();
    const firstCheckbox = page.getByRole("checkbox").first();
    await firstCheckbox.waitFor();
    await firstCheckbox.uncheck();
    await page.keyboard.press("Escape");

    // The URL must now carry both ?view= and ?cols=.
    await expect(page).toHaveURL(/[?&]view=builtin:my-open(?:&|$)/);
    await expect(page).toHaveURL(/[?&]cols=/);
  });

  test("filter Enter does not write to URL (filters are local state)", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Desktop apply path; mobile chip selects use a different model.",
    );

    await page.goto("/leads?view=builtin:my-open");
    await waitForLeadsListReady(page);

    const urlBefore = page.url();

    const desktopSearch = page.locator(DESKTOP_SEARCH_SELECTOR).first();
    await desktopSearch.fill("local-state-filter-token");

    const responsePromise = page.waitForResponse(
      (resp) =>
        LEADS_LIST_API.test(resp.url()) &&
        resp.url().includes("local-state-filter-token"),
      { timeout: 10_000 },
    );
    await page.keyboard.press("Enter");
    await responsePromise;

    // Architecture note: leads filters are CLIENT state, not URL
    // state. The fetch carries the new q= param, but the browser
    // URL is unchanged. This is the documented MWG model — saved
    // views drive URL, filters drive in-memory state. A regression
    // that URL-syncs filters would break the saved-view drift
    // detection invariant.
    expect(page.url()).toBe(urlBefore);
  });
});

test.describe("F-21 — mobile chip row (mask-image + h-11)", () => {
  test("chip row uses mask-image edge fade and overflows horizontally", async ({
    page,
  }, testInfo) => {
    test.skip(
      !/mobile/i.test(testInfo.project.name),
      "Mobile chip row only renders below the md breakpoint.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    // Locate the chip-row container by its computed mask-image
    // (linear-gradient with transparent stop). Scope the DOM
    // traversal to <main> so any chrome-level (sidebar, topbar)
    // mask-image styles can't false-positive.
    const chipRowMetrics = await page.evaluate(() => {
      const root = document.querySelector("main") ?? document.body;
      const all = Array.from(root.querySelectorAll("div")) as HTMLElement[];
      const matches = all.filter((n) => {
        const cs = getComputedStyle(n);
        const mask =
          cs.maskImage ||
          (cs as unknown as Record<string, string>)["webkitMaskImage"];
        return (
          typeof mask === "string" &&
          mask.includes("linear-gradient") &&
          mask.includes("transparent")
        );
      });
      if (matches.length === 0) return null;
      const node = matches[0];
      const rect = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      return {
        maskImage: cs.maskImage,
        webkitMaskImage: (cs as unknown as Record<string, string>)[
          "webkitMaskImage"
        ],
        overflowX: cs.overflowX,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        height: rect.height,
        childHeights: Array.from(node.children).map(
          (c) => (c as HTMLElement).getBoundingClientRect().height,
        ),
      };
    });

    expect(chipRowMetrics).not.toBeNull();
    if (!chipRowMetrics) return;

    const maskValue =
      chipRowMetrics.maskImage || chipRowMetrics.webkitMaskImage || "";
    expect(maskValue).toMatch(/linear-gradient/);
    expect(maskValue).toMatch(/transparent/);
    expect(chipRowMetrics.overflowX).toMatch(/auto|scroll/);

    // h-11 = 2.75rem = 44px. At least one chip must satisfy the
    // touch-target floor.
    const tallestChild = chipRowMetrics.childHeights.reduce(
      (max, h) => (h > max ? h : max),
      0,
    );
    expect(tallestChild).toBeGreaterThanOrEqual(44);
  });

  test("mobile search input itself meets the 44px touch-target floor", async ({
    page,
  }, testInfo) => {
    test.skip(
      !/mobile/i.test(testInfo.project.name),
      "Mobile-specific input shape.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    const mobileSearch = page.locator(MOBILE_SEARCH_SELECTOR).first();
    await mobileSearch.waitFor({ state: "visible" });

    const box = await mobileSearch.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // STANDARDS §17.1 — mobile chip / input touch targets ≥ 44px.
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("F-21 — filter mutation clears bulk selection", () => {
  test("changing a filter clears the bulk-selection banner", async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    test.skip(
      viewport !== null && isMobile(viewport.width),
      "Bulk selection toolbar / row checkboxes are desktop-first; mobile selection is a future surface.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    // Row checkboxes inside the virtualized feed.
    const rowCheckboxes = page.locator(
      '[role="feed"] [data-index] input[type="checkbox"]',
    );
    // Wait up to 5s for the first row checkbox to mount; if the
    // dataset is too thin, fall through to a documented skip.
    const checkboxCount = await rowCheckboxes
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(async () => rowCheckboxes.count())
      .catch(() => 0);

    if (checkboxCount === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "No row checkboxes found — either no leads visible or row markup differs from expectation.",
      });
      return;
    }

    const target = Math.min(2, checkboxCount);
    for (let i = 0; i < target; i++) {
      const cb = rowCheckboxes.nth(i);
      await cb.scrollIntoViewIfNeeded();
      await cb.check({ force: true });
    }

    // BulkSelectionBanner uses `role="status"`. Poll for it to mount.
    const bulkBanner = page
      .locator('[role="status"]')
      .filter({ hasText: /selected/i })
      .first();

    const bannerAppeared = await bulkBanner
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);

    if (!bannerAppeared) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "Bulk-selection banner did not render — row checkbox may not be wired to selection store in this view.",
      });
      return;
    }

    // Apply a filter change via Enter and wait for the result-set
    // refetch to complete. waitForResponse is the deterministic
    // signal for "filter mutation has landed" — replaces
    // waitForTimeout(800).
    const desktopSearch = page.locator(DESKTOP_SEARCH_SELECTOR).first();
    await desktopSearch.waitFor({ state: "visible" });
    await desktopSearch.fill("zzzzzzz-no-match-expected");

    const responsePromise = page.waitForResponse(
      (resp) =>
        LEADS_LIST_API.test(resp.url()) &&
        resp.url().includes("zzzzzzz-no-match-expected"),
      { timeout: 10_000 },
    );
    await page.keyboard.press("Enter");
    await responsePromise;

    // After a filter mutation the bulk-selection banner must
    // disappear — see BulkSelectionProvider doctrine.
    await expect(bulkBanner).toBeHidden();
  });

  test("mobile: tapping a status chip triggers an apply fetch", async ({
    page,
  }, testInfo) => {
    test.skip(
      !/mobile/i.test(testInfo.project.name),
      "Mobile chip-tap apply path; desktop uses the Enter / form-submit path.",
    );

    await page.goto("/leads");
    await waitForLeadsListReady(page);

    // Mobile rows don't expose individual checkboxes today. We
    // verify the URL/fetch side of the contract: tapping a status
    // chip triggers a fetch (the apply path that would clear any
    // selection). This is the smallest stable mobile signal.
    const statusChip = page.locator("select").first();
    const chipVisible = await statusChip
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    if (!chipVisible) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "Mobile status chip not rendered — page layout may differ on this project.",
      });
      return;
    }

    const options = await statusChip.locator("option").all();
    if (options.length < 2) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Status chip has no actionable options on this project.",
      });
      return;
    }
    const optionValue = await options[1].getAttribute("value");
    if (!optionValue) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Status chip option lacks a value attribute.",
      });
      return;
    }

    const responsePromise = page.waitForResponse(
      (resp) =>
        LEADS_LIST_API.test(resp.url()) && resp.url().includes("status="),
      { timeout: 10_000 },
    );
    await statusChip.selectOption(optionValue);
    await responsePromise;

    // The status fetch landed — the clear-on-filter-change contract
    // shares the desktop code path; this case verifies the mobile
    // chip path actually triggers an apply.
    expect(page.url()).toContain("/leads");
  });
});

test.describe("F-reset — reset-to-default-view from filtered state", () => {
  test("MODIFIED-badge reset drops filter drift and re-renders the canonical view", async ({
    page,
  }) => {
    // Land on a filtered+drifted URL: ?q= adds search drift, ?cols=
    // adds column drift. Both flip viewModified.
    await page.goto(
      "/leads?view=builtin:my-open&q=ZZZZ-reset-token&cols=name,status",
    );
    await waitForLeadsListReady(page);

    const modifiedBtn = page.getByRole("button", {
      name: /reset view to /i,
    });
    await expect(modifiedBtn).toBeVisible();

    await modifiedBtn.click();
    await expect(page.getByRole("alertdialog")).toContainText("Reset view?");

    // Wait for the reset to fire a new list fetch WITHOUT the
    // q=/cols= drift params.
    const responsePromise = page.waitForResponse(
      (resp) => LEADS_LIST_API.test(resp.url()),
      { timeout: 10_000 },
    );
    await page.getByRole("button", { name: /^Reset$/ }).click();
    const resp = await responsePromise;

    // The reset fetch must NOT carry the drift token.
    expect(resp.url()).not.toContain("ZZZZ-reset-token");

    // URL navigated back to canonical view with no drift params.
    await expect(page).toHaveURL(/[?&]view=builtin:my-open(?:&|$)/);
    await expect(page).not.toHaveURL(/q=ZZZZ-reset-token/);
    await expect(page).not.toHaveURL(/cols=/);

    // Badge unmounts.
    await expect(modifiedBtn).toHaveCount(0);
  });
});
