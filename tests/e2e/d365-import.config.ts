/**
 * Phase 23 — Playwright config override for d365-import.spec.ts only.
 *
 * The root playwright.config.ts is shared across all suites. This file
 * overrides three things specific to the D365 import suite:
 *
 *  - workers: 1   (mutates DB state; serialize)
 *  - per-test default timeout: 30s
 *  - longer timeout (60s) for fetch / commit cases (annotated via
 *    `test.slow()` or per-test `test.setTimeout(60_000)` inside the
 *    spec when needed; this file only sets the default ceiling)
 *  - testMatch: limit to d365-import.spec.ts
 *
 * Run:
 *   pnpm playwright test --config tests/e2e/d365-import.config.ts
 *
 * Inherits storage state, baseURL, projects, globalSetup, and
 * globalTeardown from the root config via spread.
 */
import { defineConfig } from "@playwright/test";
import root from "../../playwright.config";

export default defineConfig({
  ...root,
  testDir: "./",
  testMatch: ["d365-import.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    ...(root.expect ?? {}),
    timeout: 10_000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../playwright-report-d365", open: "never" }],
  ],
  use: {
    ...(root.use ?? {}),
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
