import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

/**
 * Infinite-scroll core behavior + scroll architecture on /leads.
 *
 * Coverage targets (review brief):
 *   F-17  Sentinel-based load-more (intersection observer) fires
 *         additional fetch on scroll without scroll-position jumps.
 *   F-18  ARIA live region inside #list-results announces row-count
 *         growth after pagination.
 *   F-19  Virtualization correctness: total rendered DOM stays
 *         bounded, virtualizer total-size grows with row count, and
 *         the user's scroll offset is preserved across row recycling.
 *   F-87  Date input click-to-open via useShowPicker — verified on
 *         /marketing/audit where datetime-local inputs render.
 *
 * Additional architectural assertions:
 *   - Window-scoped vertical scroll, single-axis horizontal carveout
 *     on the desktop table region (STANDARDS §16).
 *   - Column-header row NOT vertically sticky (sticky-inside-
 *     overflow-x would pin to wrapper, not viewport).
 *   - Popover dismissal via useClickOutside (no fixed-inset backdrop).
 *   - Load-more button keyboard-reachable, fires on Enter.
 *   - No client-side console errors during page load + pagination.
 *
 * Read-only suite — no records created. The E2E_RUN_ID header still
 * flows through the auth fixture so request audit rows are tagged.
 */

/** Maximum data-index currently rendered in any virtualized container. */
async function getMaxDataIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll("[data-index]");
    let max = -1;
    nodes.forEach((n) => {
      const v = Number(n.getAttribute("data-index"));
      if (Number.isFinite(v) && v > max) max = v;
    });
    return max;
  });
}

/** Wait for the first virtualized row to render (not just feed mount). */
async function waitForFirstRow(page: Page): Promise<void> {
  await page
    .locator('[role="feed"] [data-index="0"]')
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
}

/**
 * Install a console-error collector. Returns a function that asserts
 * no errors were emitted. Filters out third-party/known-benign noise
 * (Microsoft Clarity, source-map 404s, browser-extension noise).
 */
function attachConsoleErrorGuard(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/clarity\.ms|googletagmanager|hotjar|extension|chrome-extension/i.test(text)) {
      return;
    }
    if (/source map|sourcemap/i.test(text)) return;
    errors.push(text);
  });
  return () => {
    if (errors.length > 0) {
      throw new Error(
        `Console errors during navigation:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  };
}

test.describe("Infinite scroll — load-more & virtualization", () => {
  test("F-17 — sentinel triggers a fetch on scroll without scroll-jump", async ({
    page,
  }) => {
    const assertNoConsoleErrors = attachConsoleErrorGuard(page);
    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const initialMaxIndex = await getMaxDataIndex(page);
    if (initialMaxIndex < 5) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Leads data set too small to verify sentinel auto-fetch (max data-index=${initialMaxIndex}).`,
      });
      return;
    }

    // If the first page already covered the dataset there's no
    // next page to fetch, so the sentinel will never fire. The page
    // surfaces this via the "End of results" footer + absence of the
    // Load-more button. Skip when we detect either signal — we're
    // exercising the sentinel contract, not asserting that more data
    // exists in production at any given moment.
    const endOfResultsVisible = await page
      .getByText(/end of results/i)
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    const loadMoreCount = await page
      .getByRole("button", { name: /^Load \d/ })
      .count();
    if (endOfResultsVisible || loadMoreCount === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Full dataset already loaded (${initialMaxIndex + 1} rows shown); no next page to fetch.`,
      });
      return;
    }

    // Scroll to the bottom — the sentinel sits inside the
    // virtualizer's tail; reaching it must dispatch fetchNextPage.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );

    // Wait for the data-index to grow rather than sleeping. Poll via
    // expect.toPass — Playwright retries with backoff until the
    // assertion succeeds or the timeout fires.
    await expect
      .poll(() => getMaxDataIndex(page), {
        timeout: 8_000,
        message: "Sentinel did not trigger fetchNextPage on scroll-to-bottom",
      })
      .toBeGreaterThan(initialMaxIndex);

    // Scroll-jump guard: after the second fetch settles, scrollY
    // must remain at the bottom (within a few px) — confirming the
    // virtualizer did not yank scroll position when new rows merged
    // into the row list. (A scroll jump from un-bounded
    // re-measurement would put scrollY mid-page.)
    const scrollDepth = await page.evaluate(() => ({
      scrollY: window.scrollY,
      docHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    }));
    const distanceFromBottom =
      scrollDepth.docHeight - (scrollDepth.scrollY + scrollDepth.viewport);
    // The new tail rows extend the doc — so distance-from-bottom of
    // ≤ one full viewport is the contract (we scrolled to bottom,
    // then rows appended below the fold). A jump would push
    // distanceFromBottom into many-viewport territory.
    expect(distanceFromBottom).toBeLessThan(scrollDepth.viewport * 2);

    assertNoConsoleErrors();
  });

  test("Load-more button is keyboard-reachable and fires on Enter", async ({
    page,
  }) => {
    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const loadMore = page.getByRole("button", { name: /^Load \d/ });
    if ((await loadMore.count()) === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "Load-more button is not rendered — current view fits in one page.",
      });
      return;
    }

    await loadMore.scrollIntoViewIfNeeded();
    await loadMore.focus();
    await expect(loadMore).toBeFocused();

    const labelBefore = (await loadMore.textContent()) ?? "";
    const initialMaxIndex = await getMaxDataIndex(page);

    await page.keyboard.press("Enter");

    // Wait until either the label text mutates OR the rendered
    // data-index grows — either is sufficient evidence Enter
    // dispatched fetchNextPage. Polling avoids arbitrary sleeps.
    await expect
      .poll(
        async () => {
          const labelAfter =
            (await page
              .getByRole("button", { name: /^Load \d/ })
              .first()
              .textContent()
              .catch(() => "")) ?? "";
          const afterMaxIndex = await getMaxDataIndex(page);
          return labelAfter !== labelBefore || afterMaxIndex > initialMaxIndex;
        },
        {
          timeout: 8_000,
          message: "Enter on Load-more did not trigger fetchNextPage",
        },
      )
      .toBe(true);
  });

  test("F-18 — ARIA live region inside #list-results announces row-count growth", async ({
    page,
  }) => {
    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const liveRegion = page
      .locator('[aria-live="polite"][aria-atomic="true"]')
      .first();
    await liveRegion.waitFor({ state: "attached" });

    // First-page render is intentionally NOT announced
    // (standard-list-page.tsx — the live region only announces
    // *deltas* after the first paint).
    const initialText = (await liveRegion.textContent()) ?? "";
    expect(initialText.trim()).toBe("");

    const loadMore = page.getByRole("button", { name: /^Load \d/ });
    if ((await loadMore.count()) === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "Load-more button is not rendered — current view fits in one page.",
      });
      return;
    }

    await loadMore.click();

    // Poll the live region until it announces — the effect runs
    // after rows.length changes, no fixed delay is reliable.
    await expect
      .poll(async () => (await liveRegion.textContent()) ?? "", {
        timeout: 8_000,
        message: "Live region did not announce row-count growth",
      })
      .toMatch(/loaded \d+ more/i);
  });

  test("F-19 — virtualization keeps DOM bounded and virtualizer total-size grows", async ({
    page,
  }) => {
    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    // Capture the virtualizer's total spacer-height before
    // pagination. The spacer is the first child div of role="feed"
    // and carries an inline style="height: Npx; ..." reflecting
    // virtualizer.getTotalSize().
    const totalSizeBefore = await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      const spacer = feed?.firstElementChild as HTMLElement | null;
      if (!spacer) return null;
      const h = parseFloat(spacer.style.height || "0");
      return Number.isFinite(h) ? h : null;
    });
    expect(totalSizeBefore).not.toBeNull();
    expect(totalSizeBefore!).toBeGreaterThan(0);

    const initialMaxIndex = await getMaxDataIndex(page);

    // Trigger sentinel fetches. Drive growth by scrolling to bottom
    // and waiting for max data-index to advance — no arbitrary
    // sleeps.
    let prevMax = initialMaxIndex;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      try {
        await expect
          .poll(() => getMaxDataIndex(page), { timeout: 4_000 })
          .toBeGreaterThan(prevMax);
        prevMax = await getMaxDataIndex(page);
      } catch {
        // No more pages — break out of the growth loop.
        break;
      }
    }

    // Bounded DOM: overscan is 6, two virtualized surfaces exist in
    // the DOM (desktop + mobile, only one visible via CSS). ~50
    // nodes each = 100 ceiling. We assert ≤ 80 to allow headroom
    // while rejecting a fully un-virtualized DOM (which would be
    // hundreds of nodes).
    const renderedRowNodes = await page
      .locator('[role="feed"] [data-index]')
      .count();
    expect(renderedRowNodes).toBeGreaterThan(0);
    expect(renderedRowNodes).toBeLessThanOrEqual(80);

    // Virtualizer total-size must have grown if data-index grew.
    const totalSizeAfter = await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      const spacer = feed?.firstElementChild as HTMLElement | null;
      if (!spacer) return null;
      const h = parseFloat(spacer.style.height || "0");
      return Number.isFinite(h) ? h : null;
    });
    if (prevMax > initialMaxIndex) {
      expect(totalSizeAfter).not.toBeNull();
      expect(totalSizeAfter!).toBeGreaterThan(totalSizeBefore!);
    }
  });

  test("F-19 — scroll offset preserved across virtualizer recycling", async ({
    page,
  }) => {
    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const initialMaxIndex = await getMaxDataIndex(page);
    if (initialMaxIndex < 5) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Leads data set too small (max data-index=${initialMaxIndex}).`,
      });
      return;
    }

    // Scroll to a mid-page offset.
    const targetY = await page.evaluate(() => {
      const target = Math.floor(document.documentElement.scrollHeight / 2);
      window.scrollTo(0, target);
      return window.scrollY;
    });

    // Allow the virtualizer one paint to recycle row nodes for the
    // new visible window — use requestAnimationFrame, not a fixed
    // sleep.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const scrollYAfter = await page.evaluate(() => window.scrollY);
    // Tolerance for sub-pixel rounding + browser-specific snap; if
    // virtualization were broken (e.g., total-size collapsed) the
    // browser would clamp scrollY to a much smaller value.
    expect(Math.abs(scrollYAfter - targetY)).toBeLessThan(50);
  });
});

test.describe("List page scroll architecture (STANDARDS §16)", () => {
  test("Horizontal overflow is scoped to the desktop table wrapper, not the document", async ({
    page,
  }) => {
    test.skip(
      page.viewportSize() !== null &&
        (page.viewportSize() as { width: number }).width < 768,
      "Desktop horizontal-overflow wrapper is hidden below md breakpoint.",
    );

    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const wrapperMetrics = await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return null;
      // Walk up until we find the overflow-x-auto wrapper.
      let node: HTMLElement | null = feed as HTMLElement;
      for (let i = 0; i < 6 && node; i++) {
        const cs = getComputedStyle(node);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") {
          return {
            tagName: node.tagName,
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
          };
        }
        node = node.parentElement;
      }
      return null;
    });

    expect(wrapperMetrics).not.toBeNull();
    expect(wrapperMetrics?.overflowX).toMatch(/auto|scroll/);
    // The wrapper's overflow-Y must not introduce a second vertical
    // scroll surface — the document is the only vertical scroller.
    expect(wrapperMetrics?.overflowY ?? "").not.toMatch(/auto|scroll|overlay/);

    // The document body itself must never have a horizontal
    // scrollbar — scrollWidth ≤ clientWidth on the html root.
    const docHorizontal = await page.evaluate(() => ({
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }));
    // 1px tolerance for sub-pixel rounding.
    expect(docHorizontal.docScrollWidth).toBeLessThanOrEqual(
      docHorizontal.docClientWidth + 1,
    );
  });

  test("Column-header row is not vertically sticky and scrolls away", async ({
    page,
  }) => {
    test.skip(
      page.viewportSize() !== null &&
        (page.viewportSize() as { width: number }).width < 768,
      "Column-header row is desktop-only (hidden md:block on parent).",
    );

    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    // The column-header row is the previous element sibling of
    // role="feed" inside the horizontal-scroll wrapper's min-w-max
    // child. (Falls back to feed.parentElement.previousElementSibling
    // in case the DOM shape evolves.)
    const columnHeaderBefore = await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return null;
      const headerRow = (feed.previousElementSibling ??
        feed.parentElement?.previousElementSibling) as HTMLElement | null;
      if (!headerRow) return null;
      const cs = getComputedStyle(headerRow);
      const rect = headerRow.getBoundingClientRect();
      return {
        position: cs.position,
        top: rect.top,
        height: rect.height,
      };
    });

    if (!columnHeaderBefore) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Could not locate the column-header row.",
      });
      return;
    }

    // Must NOT be sticky — sticky inside overflow-x-auto would pin
    // relative to the wrapper, not the viewport.
    expect(columnHeaderBefore.position).not.toBe("sticky");

    // Need enough document height to scroll past the chrome+header.
    const docHeight = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const viewportH = page.viewportSize()?.height ?? 720;
    if (docHeight < viewportH + 400) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `List too short to scroll past the header row (docHeight=${docHeight}, viewport=${viewportH}).`,
      });
      return;
    }

    await page.evaluate(() => window.scrollTo(0, 800));
    // Wait for the scroll to settle — one rAF instead of an
    // arbitrary sleep.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        ),
    );

    const columnHeaderAfter = await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return null;
      const headerRow = (feed.previousElementSibling ??
        feed.parentElement?.previousElementSibling) as HTMLElement | null;
      if (!headerRow) return null;
      const rect = headerRow.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });

    if (!columnHeaderAfter) return;

    const scrolledY = await page.evaluate(() => window.scrollY);
    if (scrolledY < 100) {
      test.info().annotations.push({
        type: "skip-reason",
        description: `Viewport too short to scroll past chrome (scrollY=${scrolledY}).`,
      });
      return;
    }

    // After scrolling, the column-header row's top must be above
    // the viewport (negative bounding-rect top) — confirming it
    // scrolled away with the rows beneath it.
    expect(columnHeaderAfter.top).toBeLessThan(0);
  });

  test("Column chooser popover dismisses on outside click (no fixed-inset backdrop)", async ({
    page,
  }) => {
    test.skip(
      page.viewportSize() !== null &&
        (page.viewportSize() as { width: number }).width < 768,
      "Column chooser surfaces from the desktop view-toolbar.",
    );

    await page.goto("/leads");
    await page
      .getByRole("heading", { name: /^Leads$/, level: 1 })
      .waitFor({ state: "visible" });
    await waitForFirstRow(page);

    const columnsTrigger = page
      .getByRole("button", { name: /columns/i })
      .first();
    if ((await columnsTrigger.count()) === 0) {
      test.info().annotations.push({
        type: "skip-reason",
        description: "Column chooser trigger not present in this view.",
      });
      return;
    }
    await columnsTrigger.click();

    // Any checkbox inside the popover proves the panel mounted.
    const popoverProbe = page.getByRole("checkbox").first();
    await expect(popoverProbe).toBeVisible();

    // Forbidden pattern check: legacy column-chooser rendered a
    // <div class="fixed inset-0"> backdrop. Replacement uses
    // useClickOutside. Detect a full-viewport position-fixed div
    // that does NOT host the popover content itself.
    const forbiddenBackdrop = await page.evaluate(() => {
      const popoverHost = document.querySelector('[role="checkbox"]')?.closest(
        '[role="dialog"], [data-radix-popper-content-wrapper], [role="menu"]',
      );
      const nodes = Array.from(document.querySelectorAll("div"));
      return nodes.some((n) => {
        if (popoverHost && popoverHost.contains(n)) return false;
        const cs = getComputedStyle(n);
        const rect = n.getBoundingClientRect();
        return (
          cs.position === "fixed" &&
          Math.abs(rect.left) <= 1 &&
          Math.abs(rect.top) <= 1 &&
          rect.width >= window.innerWidth - 1 &&
          rect.height >= window.innerHeight - 1 &&
          rect.width * rect.height > 100_000
        );
      });
    });
    expect(forbiddenBackdrop).toBe(false);

    // Click somewhere clearly outside the popover — the row list
    // works because it is in the document but not inside the
    // popover content wrapper.
    const firstRow = page.locator('[role="feed"] [data-index="0"]').first();
    await firstRow.waitFor({ state: "attached" });
    await firstRow.click({ position: { x: 5, y: 5 }, force: true });

    // toBeHidden has built-in retry — no arbitrary sleep needed.
    await expect(popoverProbe).toBeHidden();
  });
});

test.describe("Date input click-to-open (STANDARDS §17.2)", () => {
  test("F-87 — datetime-local inputs on /marketing/audit are wired through useShowPicker", async ({
    page,
  }) => {
    test.skip(
      page.viewportSize() !== null &&
        (page.viewportSize() as { width: number }).width < 640,
      "Datetime-local input bar too narrow on small mobile viewports for the click-position assertion.",
    );

    await page.goto("/marketing/audit");

    const fromInput = page.locator('input[type="datetime-local"][name="from"]');
    await fromInput.waitFor({ state: "visible" });

    // Static contract: the input must support showPicker().
    const showPickerAvailable = await fromInput.evaluate(
      (el) =>
        "showPicker" in (el as HTMLInputElement) &&
        typeof (el as HTMLInputElement).showPicker === "function",
    );
    expect(showPickerAvailable).toBe(true);

    // Instrument HTMLInputElement.prototype.showPicker before the
    // click. The spy DOES NOT call the original — invoking the
    // native picker in headed Chromium can block the next input
    // event in slow runs, and the spy alone proves the hook fired.
    await page.evaluate(() => {
      type SpyState = {
        originalShowPicker: () => void;
        callCount: number;
      };
      const w = window as unknown as { __mwgPickerSpy?: SpyState };
      const proto = HTMLInputElement.prototype;
      w.__mwgPickerSpy = {
        originalShowPicker: proto.showPicker,
        callCount: 0,
      };
      proto.showPicker = function () {
        w.__mwgPickerSpy!.callCount += 1;
      };
    });

    try {
      // Click near the start of the input bar — emulates a real
      // user clicking somewhere other than the trailing calendar
      // icon. The onClick={useShowPicker()} handler must invoke
      // showPicker() on the element.
      const box = await fromInput.boundingBox();
      expect(box).not.toBeNull();
      await fromInput.click({
        position: {
          x: Math.max(8, Math.floor((box?.width ?? 120) * 0.25)),
          y: Math.max(8, Math.floor((box?.height ?? 32) / 2)),
        },
      });

      const called = await page.evaluate(() => {
        const w = window as unknown as {
          __mwgPickerSpy?: { callCount: number };
        };
        return w.__mwgPickerSpy?.callCount ?? 0;
      });
      expect(called).toBeGreaterThan(0);
    } finally {
      // Restore the original showPicker so the patched prototype
      // does not leak into the next test in the same browser
      // context (Playwright creates a fresh context per test by
      // default, but defensive cleanup is cheap).
      await page.evaluate(() => {
        const w = window as unknown as {
          __mwgPickerSpy?: {
            originalShowPicker: () => void;
            callCount: number;
          };
        };
        if (w.__mwgPickerSpy?.originalShowPicker) {
          HTMLInputElement.prototype.showPicker =
            w.__mwgPickerSpy.originalShowPicker;
        }
        delete w.__mwgPickerSpy;
      });
    }
  });
});
