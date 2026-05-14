/* eslint-disable react-hooks/rules-of-hooks */
// Playwright fixture extension uses a `use` parameter. The eslint
// react-hooks plugin treats anything named `use` as a React hook.
// Disable for this file — there's no React in here.

import { test as base, expect } from "@playwright/test";
import { E2E_RUN_ID } from "./run-id";

/**
 * Phase 12 — Playwright fixture that injects the E2E run-id header on
 * every request. The proxy middleware reads it and stamps audit-log
 * rows so /admin/audit can filter test traffic out by default.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.context().setExtraHTTPHeaders({
      "X-E2E-Run-Id": E2E_RUN_ID,
    });
    await use(page);
  },
});

export { expect };
