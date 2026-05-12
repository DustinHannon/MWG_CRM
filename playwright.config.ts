import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 12 — production-only Playwright suite.
 *
 * The CRM has one environment: https://crm.morganwhite.com. Tests run
 * against it with a real Entra account (configured without MFA per
 * user direction); credentials live in env vars
 * PLAYWRIGHT_LOGIN_EMAIL / PLAYWRIGHT_LOGIN_PASSWORD only — never in
 * source. Auth state is captured once per ~6h in
 * `tests/e2e/.auth/croom.json` by global-setup so individual specs
 * don't re-trigger Entra SSO.
 *
 * `workers: 1` keeps load on production polite. Cross-actor specs are
 * `test.skip` until a second test identity is provisioned.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  globalSetup: require.resolve("./tests/e2e/global-setup.ts"),
  globalTeardown: require.resolve("./tests/e2e/global-teardown.ts"),
  use: {
    baseURL: "https://crm.morganwhite.com",
    storageState: "tests/e2e/.auth/croom.json",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-iphone",
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "tablet-ipad",
      use: { ...devices["iPad (gen 7)"] },
    },
  ],
});
