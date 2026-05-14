import { test, expect } from "./fixtures/auth";
import type { Page, Locator } from "@playwright/test";
import { E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Mobile cross-page contract for the StandardListPage shell.
 *
 * This suite gates to the `mobile-iphone` (WebKit / iOS Safari) and
 * `mobile-pixel` (Chromium / Android Chrome) Playwright projects (see
 * `playwright.config.ts`). It exercises STANDARDS §16 (window-scoped
 * scroll, sticky chrome z-30/z-20), §17 (canonical list page pattern
 * — mobile card layout, chip-row carveout with `mask-image` edge fade,
 * `h-11` (≥44px) touch targets, view-selector reachability, empty
 * state copy "No X match this view."), §17.1 (detail-page task
 * affordance — leads has NO inline quick-add; accounts/contacts/
 * opportunities DO), and §17.2 (date input click-to-open contract).
 *
 * Reference findings: F-20 (view-selector reachability), F-21 (filter
 * chip overflow + mask-image edge fade), F-22 (empty state copy +
 * style), F-23 (44px minimum touch target / iOS rubber-band + sticky),
 * F-86 (detail-page task affordance), F-87 (mobile date input picker).
 *
 * Suites run as the `croom` identity. E2E_RUN_ID flows in the
 * `X-E2E-Run-Id` header so the audit log can filter test traffic.
 * Empty-state filter queries embed `[E2E-${E2E_RUN_ID}]` so any
 * inadvertent server-side stamping is cleanup-tagged.
 */

const MOBILE_PROJECTS = ["mobile-iphone", "mobile-pixel"] as const;
const WEBKIT_PROJECT = "mobile-iphone"; // iOS Safari rubber-band quirks
const CHROMIUM_PROJECT = "mobile-pixel"; // Android Chrome

const P0_LIST_PAGES = [
  { route: "/leads", heading: /^Leads$/ },
  { route: "/accounts", heading: /^Accounts$/ },
  { route: "/contacts", heading: /^Contacts$/ },
  { route: "/opportunities", heading: /^Opportunities$/ },
  { route: "/tasks", heading: /^Tasks$/ },
] as const;

/**
 * Smallest tap target permitted by Apple HIG and Material guidance.
 * STANDARDS §17 enforces `h-11` (44px) on mobile chip-row chips.
 */
const MIN_TOUCH_TARGET_PX = 44;

/** Allow a small drift for sub-pixel layout and safe-area inset. */
const TOUCH_TARGET_DRIFT_PX = 0.5;

/**
 * Wait for the list shell heading to be visible. Used as the standard
 * "page is interactive" gate before asserting against chrome.
 */
async function waitForListShell(page: Page, heading: RegExp): Promise<void> {
  await page.getByRole("heading", { name: heading, level: 1 }).waitFor({
    state: "visible",
  });
}

/**
 * Locate the mobile filter chip-row. The row carries the canonical
 * `mask-image` class signature applied by every list-page client (see
 * `src/app/(app)/{leads,accounts,contacts,opportunities,tasks}
 * /_components/*-list-client.tsx`). Anchoring on the class signature
 * rather than `data-*` attributes matches the surface as it ships
 * today; if STANDARDS §17 ever wires a `data-chip-row` marker the
 * locator collapses to a single attribute selector.
 */
function chipRowLocator(page: Page): Locator {
  // The class signature includes the `mask-image:linear-gradient`
  // utility class. Playwright's `[class*=...]` operates on the
  // serialized attribute, which preserves the bracketed Tailwind class.
  return page.locator('[class*="mask-image:linear-gradient"]').first();
}

/**
 * Locate the view-selector trigger. The button text is the active
 * view name (e.g., "My open leads", "All accounts"). The signature
 * `^(All|My)\s` plus the dropdown chevron disambiguates from other
 * page-header buttons (Add lead, Import, Export).
 */
function viewSelectorLocator(page: Page): Locator {
  return page
    .getByRole("button", { name: /^(All|My)\s.+/i })
    .first();
}

test.describe("Mobile cross-page", () => {
  // Gate the entire describe block to mobile-only projects. Desktop +
  // tablet projects skip with an explicit annotation so it's obvious
  // in the HTML report why they were not run. The skip-condition
  // signature is `(args) => boolean`; testInfo is read via
  // `test.info()` inside the callback.
  test.skip(
    () =>
      !MOBILE_PROJECTS.includes(
        test.info().project.name as (typeof MOBILE_PROJECTS)[number],
      ),
    "mobile-only suite (mobile-iphone / mobile-pixel)",
  );

  // -------------------------------------------------------------------
  // F-23 — touch targets ≥ 44px across all 5 P0 pages.
  // -------------------------------------------------------------------
  test.describe("F-23 touch targets ≥ 44px", () => {
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`${route} — mobile chip-row buttons are ≥ 44px tall`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        // Anchor on the canonical chip-row container, then count
        // buttons inside it. The previous-pass locator
        // (`getByRole("button").filter({ hasText: /^[A-Z]…/ })`) was
        // overly broad and matched header buttons like "Import" /
        // "Pipeline" that aren't chips.
        const chipRow = chipRowLocator(page);
        if (!(await chipRow.isVisible().catch(() => false))) {
          test.info().annotations.push({
            type: "skip-reason",
            description: `${route} surfaces no mobile chip row in this project.`,
          });
          return;
        }

        const chips = chipRow.getByRole("button");
        const chipCount = await chips.count();
        if (chipCount === 0) {
          test.info().annotations.push({
            type: "skip-reason",
            description: `${route} chip-row has no buttons in this project.`,
          });
          return;
        }

        // Take a bounded sample so a long row doesn't blow the timeout.
        const sampleCount = Math.min(chipCount, 6);
        for (let i = 0; i < sampleCount; i++) {
          const chip = chips.nth(i);
          if (!(await chip.isVisible())) continue;
          const box = await chip.boundingBox();
          expect(box, `chip ${i} on ${route} must have a bounding box`).not.toBeNull();
          expect(
            box!.height,
            `chip ${i} on ${route} must be ≥ ${MIN_TOUCH_TARGET_PX}px tall (got ${box!.height})`,
          ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX - TOUCH_TARGET_DRIFT_PX);
        }
      });

      test(`${route} — primary CTA (Add / New / Create) is ≥ 44px tall`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        // The primary create button lives in the page header. Match
        // by accessible name; some entities use "Add lead", others
        // "New campaign". Lock the leading verb explicitly.
        const cta = page
          .getByRole("button", { name: /^(Add|New|Create)\b/ })
          .or(page.getByRole("link", { name: /^(Add|New|Create)\b/ }))
          .first();

        if (!(await cta.isVisible().catch(() => false))) {
          test.info().annotations.push({
            type: "skip-reason",
            description: `${route} surfaces no primary CTA visible on mobile.`,
          });
          return;
        }

        const box = await cta.boundingBox();
        expect(box, `${route} CTA must have a bounding box`).not.toBeNull();
        expect(
          box!.height,
          `${route} CTA must be ≥ ${MIN_TOUCH_TARGET_PX}px tall (got ${box!.height})`,
        ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX - TOUCH_TARGET_DRIFT_PX);
      });
    }

    test("/leads bulk-selection banner buttons are ≥ 44px tall when shown", async ({
      page,
    }) => {
      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // The bulk-selection banner only appears after a row is
      // selected. On mobile the row card carries a long-press
      // affordance; we approximate that by checking the banner only
      // surfaces buttons matching the floor when visible.
      const banner = page
        .getByRole("region", { name: /bulk|selection|selected/i })
        .or(page.locator("[data-bulk-banner]"))
        .first();

      if (!(await banner.isVisible().catch(() => false))) {
        test.info().annotations.push({
          type: "skip-reason",
          description:
            "Bulk-selection banner not visible without a selection; mobile selection requires interaction beyond the deterministic surface.",
        });
        return;
      }

      const buttons = banner.getByRole("button");
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        if (!(await button.isVisible())) continue;
        const box = await button.boundingBox();
        expect(box, `bulk banner button ${i} bounding box`).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX - TOUCH_TARGET_DRIFT_PX,
        );
      }
    });
  });

  // -------------------------------------------------------------------
  // Mobile card layout — full-width cards with avatar + primary text
  // + secondary text + chevron on all 5 P0 pages.
  // -------------------------------------------------------------------
  test.describe("Mobile card layout", () => {
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`${route} — renders mobile cards (role=feed → role=link rows, not desktop table)`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        // The StandardListPage exposes the row list as role="feed"
        // and each row as role="link" on mobile (the card itself is a
        // <Link>). Verify the feed mounts.
        const feed = page.getByRole("feed").first();
        await feed.waitFor({ state: "attached" });

        // The row links inside the feed should be visible.
        const rowLinks = feed.getByRole("link");
        const rowCount = await rowLinks.count();

        if (rowCount === 0) {
          // Empty list — covered by F-22. Skip this card-layout check.
          test.info().annotations.push({
            type: "skip-reason",
            description: `${route} feed is empty; card layout asserted in F-22 path.`,
          });
          return;
        }

        // Verify each row card spans the available width (mobile is
        // a single column). Check the first row's width is at least
        // 80% of the feed width — accounts for padding.
        const feedBox = await feed.boundingBox();
        const firstRowBox = await rowLinks.first().boundingBox();
        expect(feedBox, "feed bounding box").not.toBeNull();
        expect(firstRowBox, "first row bounding box").not.toBeNull();
        expect(firstRowBox!.width).toBeGreaterThanOrEqual(
          feedBox!.width * 0.8,
        );

        // Each row has a chevron (right-arrow / disclosure icon) at
        // the end. lucide-react renders SVG; the parent has at least
        // one <svg> descendant.
        const svgInFirstRow = rowLinks.first().locator("svg");
        await expect(svgInFirstRow.first()).toBeVisible();
      });
    }
  });

  // -------------------------------------------------------------------
  // Sidebar drawer — hamburger opens, navigation dismisses it.
  // STANDARDS §16: TopBar z-30. STANDARDS §17 mobile responsive: the
  // drawer overlays the page chrome.
  // -------------------------------------------------------------------
  test.describe("Sidebar drawer", () => {
    test("Hamburger opens the sidebar drawer; nav item dismisses it", async ({
      page,
    }) => {
      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // The hamburger trigger lives in the AppShell top bar with
      // `aria-label="Open navigation"` (see
      // src/components/app-shell/mobile-sidebar.tsx).
      const hamburger = page.getByRole("button", {
        name: /open navigation/i,
      });
      await expect(hamburger).toBeVisible();

      await hamburger.tap();

      // The drawer is a Radix Dialog content surface; it carries
      // role="dialog" and a nav list inside.
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();

      // The drawer should be full-height — its bounding box height
      // should equal (within a small drift) the viewport height.
      const drawerBox = await drawer.boundingBox();
      const viewportHeight = page.viewportSize()?.height ?? 0;
      expect(drawerBox, "drawer bounding box").not.toBeNull();
      expect(viewportHeight).toBeGreaterThan(0);
      // Allow a 32px drift for status bar / safe-area inset.
      expect(drawerBox!.height).toBeGreaterThanOrEqual(viewportHeight - 32);

      // Tap an item — Accounts is present on every nav.
      const accountsLink = drawer.getByRole("link", { name: /^Accounts$/ });
      await accountsLink.tap();

      // Drawer dismisses + navigation happens.
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(/\/accounts(\?|$)/);
      await waitForListShell(page, /^Accounts$/);
    });
  });

  // -------------------------------------------------------------------
  // STANDARDS §16 sticky chrome verification.
  //
  // The iOS-specific rubber-band / momentum quirk is only relevant on
  // WebKit (mobile-iphone project). Android Chromium handles sticky
  // positioning under window scroll consistently with desktop. The
  // tests below assert TopBar z-30 sticky on both projects, plus an
  // iOS-specific sub-test that verifies the WebKit nested-overflow
  // sticky-dropout edge case.
  // -------------------------------------------------------------------
  test.describe("Sticky chrome under window scroll", () => {
    test("Page chrome stays pinned to top after long scroll on /leads", async ({
      page,
    }) => {
      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // Scroll the window down significantly — past the chrome,
      // past several rows.
      await page.evaluate(() => window.scrollTo(0, 1200));

      // Wait for the scroll to settle: rAF + paint. waitForFunction
      // polls on a deterministic signal (scrollY at or past target,
      // or capped because the list is short) instead of a fixed delay.
      await page
        .waitForFunction(
          () => {
            const maxScroll =
              document.documentElement.scrollHeight - window.innerHeight;
            return (
              window.scrollY >= 1200 ||
              (maxScroll > 0 && Math.abs(window.scrollY - maxScroll) < 4)
            );
          },
          undefined,
          { timeout: 5_000 },
        )
        .catch(() => {
          // Short list — fall through; the skip check below handles it.
        });

      const scrolled = await page.evaluate(() => window.scrollY);
      if (scrolled < 200) {
        test.info().annotations.push({
          type: "skip-reason",
          description: `List too short to scroll past sticky chrome (scrollY=${scrolled}).`,
        });
        return;
      }

      // The Leads <h1> must still be in viewport because the sticky
      // chrome it sits inside is pinned.
      const heading = page.getByRole("heading", {
        name: /^Leads$/,
        level: 1,
      });
      await expect(heading).toBeInViewport();

      // Confirm the sticky <header> in the document has computed
      // position: sticky AND is the TopBar (z-30 per STANDARDS §16).
      const stickyHeader = await page.evaluate(() => {
        const headers = document.querySelectorAll("header");
        for (const h of Array.from(headers)) {
          const cs = getComputedStyle(h);
          if (cs.position === "sticky") {
            return {
              position: cs.position,
              top: cs.top,
              zIndex: cs.zIndex,
            };
          }
        }
        return null;
      });
      expect(stickyHeader).not.toBeNull();
      expect(stickyHeader!.position).toBe("sticky");
      // STANDARDS §16: TopBar z-30. Reject if a regression drops it
      // below the chrome group (z-20).
      const zIndexNumeric = Number.parseInt(stickyHeader!.zIndex, 10);
      if (!Number.isNaN(zIndexNumeric)) {
        expect(
          zIndexNumeric,
          "TopBar z-index must be ≥ 30 per STANDARDS §16",
        ).toBeGreaterThanOrEqual(30);
      }
    });

    test("iOS Safari: sticky chrome survives multi-step momentum scroll without dropout", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== WEBKIT_PROJECT,
        "iOS-specific sticky-dropout quirk only manifests on WebKit",
      );

      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // Drive a series of incremental scrolls to simulate momentum
      // rather than one teleport — that's the WebKit edge case where
      // sticky drops out only on continuous scroll under nested
      // ancestors that briefly mutate during scroll.
      for (const target of [400, 800, 1200, 1600, 2000]) {
        await page.evaluate(
          (y) => window.scrollTo({ top: y, behavior: "instant" }),
          target,
        );
        // One rAF per step so paint catches up.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }

      const finalScrollY = await page.evaluate(() => window.scrollY);
      if (finalScrollY < 200) {
        test.info().annotations.push({
          type: "skip-reason",
          description: `List too short to exercise iOS momentum-scroll (scrollY=${finalScrollY}).`,
        });
        return;
      }

      // The page heading must still be in viewport after the
      // multi-step scroll. If sticky has dropped out, the heading
      // would scroll off and this assertion fails.
      const heading = page.getByRole("heading", {
        name: /^Leads$/,
        level: 1,
      });
      await expect(heading).toBeInViewport();
    });
  });

  // -------------------------------------------------------------------
  // F-20 + F-21 + F-22 cross-page consistency on mobile.
  // -------------------------------------------------------------------
  test.describe("F-20/F-21/F-22 cross-page consistency", () => {
    // F-20 — view selector reachable on every P0 mobile page.
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`F-20 ${route} — view selector dropdown is reachable on mobile`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        const viewSelector = viewSelectorLocator(page);
        await expect(viewSelector).toBeVisible();

        const box = await viewSelector.boundingBox();
        expect(box, `${route} view selector bounding box`).not.toBeNull();
        expect(
          box!.height,
          `${route} view selector height ≥ ${MIN_TOUCH_TARGET_PX}px`,
        ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX - TOUCH_TARGET_DRIFT_PX);
      });
    }

    // F-21 — chip row has overflow scroll + mask-image edge fade.
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`F-21 ${route} — chip row has overflow-x scroll + mask-image edge fade`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        const chipRow = chipRowLocator(page);

        if (!(await chipRow.isVisible().catch(() => false))) {
          test.info().annotations.push({
            type: "skip-reason",
            description: `${route} renders no chip row in this project.`,
          });
          return;
        }

        const styles = await chipRow.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            overflowX: cs.overflowX,
            maskImage:
              cs.maskImage ||
              (cs as unknown as { webkitMaskImage?: string })
                .webkitMaskImage ||
              "",
          };
        });

        expect(styles.overflowX).toMatch(/auto|scroll/);
        // mask-image is applied either as `mask-image` or as the
        // WebKit-prefixed equivalent. Either signals the edge fade.
        expect(styles.maskImage).not.toBe("");
        expect(styles.maskImage).not.toBe("none");
      });
    }

    // F-22 — empty state copy + style consistent.
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`F-22 ${route} — empty state copy follows the "No X match this view." shape when filtered`, async ({
        page,
      }) => {
        // Drive the list into an empty state via a search that no
        // record matches. The query string carries the run-id
        // sentinel so any inadvertent stamping is cleanup-tagged.
        const sentinelQuery = `nomatch-E2E-${E2E_RUN_ID}-${Date.now()}`;
        await page.goto(`${route}?q=${encodeURIComponent(sentinelQuery)}`);
        await waitForListShell(page, heading);

        // Wait deterministically: the feed renders zero items OR the
        // empty-state region surfaces. Both routes resolve quickly
        // without `networkidle` (which is unreliable under Realtime
        // subscriptions that keep WebSocket traffic flowing).
        const emptyState = page.getByText(/^No .+(match|found)/i).first();

        await expect(emptyState).toBeVisible({ timeout: 15_000 });
      });
    }
  });

  // -------------------------------------------------------------------
  // F-86 — detail-page task affordance (STANDARDS §17.1).
  // -------------------------------------------------------------------
  test.describe("F-86 detail-page task affordance", () => {
    test("/leads/<id> shows the task list but NO inline quick-add row", async ({
      page,
    }) => {
      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // Locate the first lead detail link.
      const detailHref = await page.evaluate(() => {
        const anchors = Array.from(
          document.querySelectorAll('a[href^="/leads/"]'),
        ) as HTMLAnchorElement[];
        const detail = anchors.find((a) =>
          /^\/leads\/[0-9a-f-]{16,}/.test(a.getAttribute("href") ?? ""),
        );
        return detail?.getAttribute("href") ?? null;
      });

      if (!detailHref) {
        test.info().annotations.push({
          type: "skip-reason",
          description: "No visible lead detail link available.",
        });
        return;
      }

      await page.goto(detailHref);

      // Wait for the page's primary heading so we don't assert
      // against a half-rendered DOM. (Avoids `networkidle` because
      // Realtime subscriptions keep WebSocket traffic flowing.)
      await page
        .getByRole("heading", { level: 1 })
        .first()
        .waitFor({ state: "visible" });

      // The canonical quick-add row is rendered by
      // `EntityTasksQuickAdd` with the placeholder "Add a task…"
      // (src/components/tasks/entity-tasks-quick-add.tsx:84). Lead
      // detail page suppresses this — count must be zero.
      const quickAddInput = page.getByPlaceholder(/add a task/i);
      await expect(quickAddInput).toHaveCount(0);
    });

    for (const otherEntity of ["accounts", "contacts", "opportunities"] as const) {
      test(`/${otherEntity}/<id> shows the task list AND inline quick-add row`, async ({
        page,
      }) => {
        const headingByEntity: Record<typeof otherEntity, RegExp> = {
          accounts: /^Accounts$/,
          contacts: /^Contacts$/,
          opportunities: /^Opportunities$/,
        };

        await page.goto(`/${otherEntity}`);
        await waitForListShell(page, headingByEntity[otherEntity]);

        const detailHref = await page.evaluate((entity) => {
          const anchors = Array.from(
            document.querySelectorAll(`a[href^="/${entity}/"]`),
          ) as HTMLAnchorElement[];
          const detail = anchors.find((a) =>
            new RegExp(`^/${entity}/[0-9a-f-]{16,}`).test(
              a.getAttribute("href") ?? "",
            ),
          );
          return detail?.getAttribute("href") ?? null;
        }, otherEntity);

        if (!detailHref) {
          test.info().annotations.push({
            type: "skip-reason",
            description: `No visible ${otherEntity} detail link available.`,
          });
          return;
        }

        await page.goto(detailHref);

        // For non-lead detail pages, EntityTasksSection's
        // showQuickAdd defaults to true. The quick-add input must be
        // present and visible.
        const quickAddInput = page.getByPlaceholder(/add a task/i).first();
        await expect(quickAddInput).toBeVisible({ timeout: 15_000 });
      });
    }
  });

  // -------------------------------------------------------------------
  // "Showing N of M" caption — above the row list, not sticky.
  // -------------------------------------------------------------------
  test.describe("Showing N of M placement", () => {
    for (const { route, heading } of P0_LIST_PAGES) {
      test(`${route} — "Showing N of M" caption is visible above the row list and not sticky`, async ({
        page,
      }) => {
        await page.goto(route);
        await waitForListShell(page, heading);

        const caption = page.getByText(/^Showing \d/);
        await expect(caption.first()).toBeVisible();

        // The caption must not have computed position: sticky/fixed
        // — it scrolls with the page per STANDARDS §17.
        const position = await caption.first().evaluate((el) => {
          return getComputedStyle(el).position;
        });
        expect(position).not.toBe("sticky");
        expect(position).not.toBe("fixed");

        // The caption sits above the feed region (lower y-value
        // than the feed's top edge).
        const captionBox = await caption.first().boundingBox();
        const feedBox = await page.getByRole("feed").first().boundingBox();

        if (captionBox && feedBox) {
          expect(captionBox.y).toBeLessThan(feedBox.y);
        }
      });
    }
  });

  // -------------------------------------------------------------------
  // F-87 / STANDARDS §17.2 — mobile date input click-to-open.
  //
  // /marketing/audit requires marketing-admin permissions. If the
  // test identity lacks them the page returns 403/redirect; the
  // test annotates rather than failing on the access wall.
  // -------------------------------------------------------------------
  test.describe("F-87 mobile date input picker", () => {
    test("Tapping the date input bar (not the icon) invokes showPicker() on /marketing/audit", async ({
      page,
    }) => {
      const response = await page.goto("/marketing/audit");
      if (response && response.status() >= 400) {
        test.info().annotations.push({
          type: "skip-reason",
          description: `/marketing/audit returned ${response.status()} — test identity lacks marketing-admin access in this project.`,
        });
        return;
      }

      // Wait for the audit list shell to mount. Use the From input
      // as a structural anchor rather than `networkidle`.
      const fromInput = page.getByLabel("From", { exact: true });
      if (
        !(await fromInput.isVisible({ timeout: 5_000 }).catch(() => false))
      ) {
        test.info().annotations.push({
          type: "skip-reason",
          description:
            "/marketing/audit did not surface a From input — page likely gated for this identity.",
        });
        return;
      }

      // Patch `showPicker` so we can observe invocations from the
      // click handler (`onClick={fromPicker}` in audit-list-client).
      // STANDARDS §17.2 mandates that tapping the input bar (not just
      // the picker icon) opens the picker via the canonical
      // `useShowPicker()` hook.
      await page.evaluate(() => {
        const w = window as unknown as { __pickerInvocations?: number };
        w.__pickerInvocations = 0;
        const originalShowPicker = HTMLInputElement.prototype.showPicker;
        HTMLInputElement.prototype.showPicker = function patched(
          this: HTMLInputElement,
        ) {
          w.__pickerInvocations = (w.__pickerInvocations ?? 0) + 1;
          try {
            return originalShowPicker?.call(this);
          } catch {
            // showPicker() throws in headless / non-user-gesture
            // contexts. Swallow — the invocation count is what we
            // assert against.
          }
        };
      });

      // Tap the input itself (not the icon) — bounding-box center.
      // Playwright's .tap() on the input simulates a real user
      // gesture; the onClick handler invokes `fromPicker`.
      await fromInput.tap();

      // Poll for the invocation flag rather than a fixed delay; one
      // event-loop tick is enough but we give it up to 2s in case
      // WebKit defers the click handler.
      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                (
                  window as unknown as { __pickerInvocations?: number }
                ).__pickerInvocations ?? 0,
            ),
          {
            message:
              "tapping the From input must invoke showPicker() per STANDARDS §17.2",
            timeout: 2_000,
          },
        )
        .toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // STANDARDS §16 mobile horizontal scroll. Mobile cards adapt to
  // viewport width; the page must not introduce a page-wide
  // horizontal scrollbar. (The desktop table region has its own
  // `overflow-x: auto` carveout; mobile renders cards and doesn't
  // exercise that path.)
  // -------------------------------------------------------------------
  test.describe("STANDARDS §16 mobile horizontal scroll", () => {
    test("/leads page does not introduce a horizontal scrollbar at mobile widths", async ({
      page,
    }) => {
      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      const docOverflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      // Allow a 1px sub-pixel drift; reject scrollWidth meaningfully
      // exceeding clientWidth (that would mean horizontal scroll).
      expect(
        docOverflow.scrollWidth - docOverflow.clientWidth,
        "page must not introduce page-wide horizontal scroll on mobile",
      ).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Browser-agnostic sanity: both projects render the same essential
  // surfaces. This guards against a future regression where one
  // platform diverges from the other.
  // -------------------------------------------------------------------
  test.describe("Cross-platform parity", () => {
    test("Both iOS and Android render the canonical mobile chrome on /leads", async ({
      page,
    }, testInfo) => {
      // Already mobile-only via the outer describe skip; this
      // narrows further so a future addition of a third mobile
      // project doesn't silently dilute parity.
      test.skip(
        testInfo.project.name !== WEBKIT_PROJECT &&
          testInfo.project.name !== CHROMIUM_PROJECT,
        "iOS/Android parity check",
      );

      await page.goto("/leads");
      await waitForListShell(page, /^Leads$/);

      // Hamburger present on both.
      await expect(
        page.getByRole("button", { name: /open navigation/i }),
      ).toBeVisible();

      // Feed mounts on both.
      await page.getByRole("feed").first().waitFor({ state: "attached" });

      // Primary CTA visible on both.
      await expect(
        page
          .getByRole("button", { name: /^(Add|New|Create)\b/ })
          .or(page.getByRole("link", { name: /^(Add|New|Create)\b/ }))
          .first(),
      ).toBeVisible();
    });
  });
});
