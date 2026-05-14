import { expect, test } from "@playwright/test";

/**
 * Phase 28 §8 — UI copy convention smoke test.
 *
 * Defense-in-depth alongside Sub-agent C's Semgrep rules:
 *
 *   mwg-ui-copy-phase-reference  (ERROR — blocks build on regression)
 *   mwg-ui-copy-banned-words     (WARNING — surfaces in CI)
 *
 * This spec walks the authenticated app shell and asserts no
 * user-facing page renders text matching "Phase N" or any of the
 * banned marketing adjectives. The Semgrep rules catch JSX-text-node
 * regressions at build time; this Playwright spec catches runtime
 * leakage from server-rendered content (database-sourced strings,
 * server-only error messages, etc.) that bypasses the Semgrep file
 * scan.
 *
 * Authenticated runs are required because most pages are session-gated;
 * the test reuses the project's standard global-setup storageState.
 */

const BASE = "https://crm.morganwhite.com";

const ROUTES_TO_CHECK = [
  "/dashboard",
  "/leads",
  "/contacts",
  "/accounts",
  "/opportunities",
  "/marketing/campaigns",
  "/marketing/lists",
  "/marketing/templates",
  "/reports",
  "/tasks",
  "/notifications",
  "/welcome",
  "/admin",
  "/admin/insights",
  "/admin/server-logs",
];

// Phase 28 §0 banned-word list. The marketing-surface allowlist in
// .semgrep/mwg.yml does NOT extend here — runtime checks ALL pages
// including the marketing composer, because MWG-marketing-team copy
// lives in TEMPLATE BODIES (rendered inside sandboxed iframes), not
// in platform chrome.
const BANNED_WORDS = [
  "powerful",
  "seamless",
  "robust",
  "comprehensive",
  "streamline",
  "holistic",
  "effortless",
  "delve",
  "leverage",
  "empower",
  "revolutionize",
] as const;

test.describe("Phase 28 — UI copy conventions", () => {
  for (const route of ROUTES_TO_CHECK) {
    test(`${route} contains no "Phase N" references`, async ({ page }) => {
      await page.goto(`${BASE}${route}`);
      // Wait for the main content region to render — every authenticated
      // page lays out under <main>. Skip the assertion gracefully if the
      // route 404s in the smoke environment (unrelated to copy rules).
      const main = page.locator("main").first();
      await main.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
      const text = await page.locator("body").innerText();
      expect(text, `route ${route} leaked an internal phase reference`).not.toMatch(/[Pp]hase\s+\d+/);
    });

    test(`${route} contains no marketing language`, async ({ page }) => {
      await page.goto(`${BASE}${route}`);
      const main = page.locator("main").first();
      await main.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
      const text = (await page.locator("body").innerText()).toLowerCase();
      for (const word of BANNED_WORDS) {
        expect(text, `route ${route} contains banned marketing word "${word}"`).not.toMatch(
          new RegExp(`\\b${word}\\b`, "i"),
        );
      }
    });
  }
});
